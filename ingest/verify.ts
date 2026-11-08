import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { GameGraph } from "../kb/schema";
import type { ProvenanceStore } from "./types";
import { loadDotEnv } from "./env";

const MODEL = process.env.COACH_VERIFY_MODEL ?? "claude-haiku-4-5";
const KEEP_THRESHOLD = 0.7;
const PROMPT_VERSION = "v2-publishers"; // bump to invalidate cached verdicts when the panel prompt changes

export interface Decision {
  decision: "keep" | "drop" | "escalate";
  confidence: number;
  basis: "corroborated" | "panel" | "absent";
  reason: string;
  groundingSources: string[];
}

export interface VerifyReport {
  total: number;
  corroborated: number;
  panelKept: number;
  panelDropped: number;
  escalated: number;
  decisions: Record<string, Decision>;
}

interface CorpusDoc {
  sourceId: string;
  text: string;
}

/** Load the ingested source corpus (wiki prose + any transcripts) — the EVIDENCE we verify against,
 *  independent of the model's memory. */
async function loadCorpus(gameDir: string): Promise<CorpusDoc[]> {
  const rawDir = join(gameDir, "_raw");
  const docs: CorpusDoc[] = [];
  let sourceDirs: string[] = [];
  try {
    sourceDirs = await readdir(rawDir);
  } catch {
    return docs;
  }
  for (const sourceId of sourceDirs) {
    const dir = join(rawDir, sourceId);
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    let text = "";
    for (const f of files) {
      if (f.endsWith("page.txt") || f.endsWith(".srt")) {
        try {
          text += "\n" + (await readFile(join(dir, f), "utf8"));
        } catch {
          /* skip */
        }
      }
    }
    if (text.trim()) docs.push({ sourceId, text: text.toLowerCase() });
  }
  return docs;
}

interface Grounding {
  sources: string[];
  snippets: { sourceId: string; snippet: string }[];
}

/** Lexical grounding: is the entity name actually attested in the corpus, and in how many sources? */
function ground(name: string, corpus: CorpusDoc[]): Grounding {
  const core = name.toLowerCase().replace(/\(.*?\)/g, "").trim();
  const sources = new Set<string>();
  const snippets: { sourceId: string; snippet: string }[] = [];
  if (core.length >= 3) {
    for (const d of corpus) {
      const idx = d.text.indexOf(core);
      if (idx >= 0) {
        sources.add(d.sourceId);
        if (snippets.length < 4)
          snippets.push({
            sourceId: d.sourceId,
            snippet: d.text
              .slice(Math.max(0, idx - 90), idx + core.length + 90)
              .replace(/\s+/g, " ")
              .trim(),
          });
      }
    }
  }
  return { sources: [...sources], snippets };
}

// --- adversarial panel (batched, cached) ---

const PANEL_TOOL = {
  name: "adjudicate",
  description: "Return a keep/drop verdict for each contested entity.",
  input_schema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ref: { type: "integer" },
            caseFor: { type: "string", description: "strongest argument it IS a real entity of this game" },
            caseAgainst: { type: "string", description: "strongest argument it is contamination / not attested" },
            keep: { type: "boolean" },
            confidence: { type: "number" },
            reason: { type: "string" },
          },
          required: ["ref", "keep", "confidence", "reason"],
        },
      },
    },
    required: ["verdicts"],
  },
} as const;

interface PanelItem {
  ref: number;
  name: string;
  kind: string;
  grounding: Grounding;
  provenance: { sourceId: string; topic: string; segmentTitle: string }[];
  publishers: number; // distinct publisher domains the entity is grounded in
  corroborated: boolean; // grounded in >= 2 distinct publishers
}

async function adjudicate(
  game: string,
  items: PanelItem[],
): Promise<Record<number, { keep: boolean; confidence: number; reason: string }>> {
  const key = process.env.ANTHROPIC_API_KEY!;
  const block = items
    .map((it) => {
      const grounded = it.grounding.sources.length
        ? `grounded in ${it.grounding.sources.length} page(s) across ${it.publishers} INDEPENDENT publisher(s)${it.corroborated ? " — corroborated by multiple publishers" : " — single publisher only, treat with caution"}`
        : "NOT found in the prose corpus";
      const ev = it.grounding.snippets.length
        ? it.grounding.snippets.map((s) => `      - [${s.sourceId}] "...${s.snippet}..."`).join("\n")
        : "      - (no prose snippet)";
      const prov = it.provenance.length
        ? it.provenance.map((p) => `${p.topic || p.sourceId}`).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4).join("; ")
        : "(unknown)";
      return `[${it.ref}] (${it.kind}) ${it.name}\n    ${grounded}\n${ev}\n    extracted from: ${prov}`;
    })
    .join("\n\n");

  const system =
    `You are an adversarial fact-checker for an auto-built knowledge graph of the video game "${game}". ` +
    `For EACH candidate decide keep/drop, using BOTH the evidence below AND your own knowledge of games.\n` +
    `Rules:\n` +
    `- DROP contamination: an entity that belongs to a DIFFERENT game (e.g. a sequel/other title in ` +
    `the same series) is contamination and must be dropped EVEN IF a wiki mentions it in passing or ` +
    `a cross-reference. Use your game knowledge to catch this.\n` +
    `- KEEP video-attested reals: an entity is real if it was "extracted from" THIS game's own ` +
    `walkthrough/boss-guide/ability source, even if the prose corpus doesn't repeat its exact name ` +
    `(it may have come from a video). Provenance is evidence.\n` +
    `- DROP descriptors: vague hedges ("Powerful new ability", "Prior to Metropolis", "Bosses ` +
    `(general)", "Unknown Area") are not real entities.\n` +
    `- confidence(0..1) reflects how clear the call is. Provide caseFor and caseAgainst. One verdict per ref.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      tools: [PANEL_TOOL],
      tool_choice: { type: "tool", name: "adjudicate" },
      system,
      messages: [{ role: "user", content: `Candidates:\n\n${block}` }],
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  const tu = (data.content ?? []).find((b: any) => b.type === "tool_use");
  const out: Record<number, { keep: boolean; confidence: number; reason: string }> = {};
  for (const v of tu?.input?.verdicts ?? [])
    out[v.ref] = { keep: !!v.keep, confidence: Number(v.confidence) || 0, reason: String(v.reason ?? "") };
  return out;
}

/** Call the panel, then RETRY the refs it skipped (a long batch can come back short). After maxRounds,
 *  anything still missing is left out → the caller escalates it as a genuine non-verdict. */
async function adjudicateComplete(
  game: string,
  items: PanelItem[],
  maxRounds = 3,
): Promise<Record<number, { keep: boolean; confidence: number; reason: string }>> {
  const result: Record<number, { keep: boolean; confidence: number; reason: string }> = {};
  let pending = items;
  for (let round = 0; round < maxRounds && pending.length > 0; round++) {
    const local = pending.map((it, i) => ({ ...it, ref: i }));
    let verdicts: Record<number, { keep: boolean; confidence: number; reason: string }> = {};
    try {
      verdicts = await adjudicate(game, local);
    } catch {
      break; // hard failure → leave the rest unresolved; caller escalates
    }
    const stillPending: PanelItem[] = [];
    for (let i = 0; i < pending.length; i++) {
      if (verdicts[i]) result[pending[i].ref] = verdicts[i];
      else stillPending.push(pending[i]);
    }
    pending = stillPending;
  }
  return result;
}

const cacheKey = (game: string, it: PanelItem) =>
  createHash("sha256")
    .update(
      [
        game,
        MODEL,
        PROMPT_VERSION,
        it.kind,
        it.name,
        it.grounding.sources.slice().sort().join(","),
        it.provenance.map((p) => p.sourceId).sort().join(","),
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 32);

interface SourceMeta {
  topic: string;
  domain: string;
}
/** Map each source id to its topic + PUBLISHER DOMAIN. Corroboration counts distinct publishers,
 *  not pages — 5 pages of one (contaminated) wiki are one voice, not five. */
async function loadSourceMeta(game: string): Promise<Record<string, SourceMeta>> {
  try {
    const reg = JSON.parse(await readFile(join(import.meta.dirname, "sources", `${game}.json`), "utf8"));
    const out: Record<string, SourceMeta> = {};
    for (const s of reg.sources ?? []) {
      let domain = `src:${s.id}`;
      try {
        if (s.url) domain = new URL(s.url).hostname.replace(/^www\./, "");
      } catch {
        /* keep src: fallback */
      }
      out[s.id] = { topic: s.topic ?? "", domain };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Auto-QA: EVERY named entity goes to the adversarial panel. Grounding + provenance are EVIDENCE the
 * panel weighs (alongside its own game knowledge), NOT an auto-decision — lexical corroboration in a
 * contaminated wiki must never auto-keep, and absence from thin prose must never auto-drop a
 * video-attested real. Escalate only low-confidence calls. Human effort = O(escalations).
 */
export async function verify(
  game: string,
  graph: GameGraph,
  prov: ProvenanceStore,
  gameDir: string,
  batchSize = 12,
  concurrency = 4,
): Promise<{ decisions: Map<string, Decision>; report: VerifyReport }> {
  loadDotEnv();
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("verify requires ANTHROPIC_API_KEY");
  const corpus = await loadCorpus(gameDir);
  const meta = await loadSourceMeta(game);
  const cacheDir = join(gameDir, "_verifycache");
  await mkdir(cacheDir, { recursive: true });

  const named = [
    ...graph.zones.map((z) => ({ id: z.id, name: z.name, kind: "zone" })),
    ...graph.abilities.map((a) => ({ id: a.id, name: a.name, kind: a.type })),
    ...graph.bosses.map((b) => ({ id: b.id, name: b.name, kind: "boss" })),
  ];

  const items: (PanelItem & { id: string })[] = named.map((e, i) => {
    const g = ground(e.name, corpus);
    const publishers = new Set(g.sources.map((sid) => meta[sid]?.domain ?? sid)).size;
    const provEv = (prov[e.id] ?? []).slice(0, 6).map((p) => ({
      sourceId: p.sourceId,
      topic: meta[p.sourceId]?.topic ?? "",
      segmentTitle: p.segmentTitle,
    }));
    return {
      ref: i,
      id: e.id,
      name: e.name,
      kind: e.kind,
      grounding: g,
      provenance: provEv,
      publishers,
      corroborated: publishers >= 2,
    };
  });

  const decisions = new Map<string, Decision>();
  const batches: (PanelItem & { id: string })[][] = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));

  let bi = 0;
  const worker = async () => {
    while (bi < batches.length) {
      const batch = batches[bi++];
      const need: (PanelItem & { id: string })[] = [];
      for (const it of batch) {
        try {
          const cached = JSON.parse(await readFile(join(cacheDir, cacheKey(game, it) + ".json"), "utf8"));
          applyVerdict(decisions, it, cached);
        } catch {
          need.push(it);
        }
      }
      if (need.length === 0) {
        process.stdout.write("c");
        continue;
      }
      const localRefs = need.map((it, i) => ({ ...it, ref: i }));
      try {
        const verdicts = await adjudicateComplete(game, localRefs);
        for (let i = 0; i < need.length; i++) {
          const v = verdicts[i];
          if (v) {
            applyVerdict(decisions, need[i], v);
            await writeFile(join(cacheDir, cacheKey(game, need[i]) + ".json"), JSON.stringify(v));
          } else {
            // genuinely no verdict after retries → escalate, and do NOT cache (retry next run)
            decisions.set(need[i].id, {
              decision: "escalate",
              confidence: 0,
              basis: "panel",
              reason: "no verdict after retries",
              groundingSources: need[i].grounding.sources,
            });
          }
        }
        process.stdout.write("V");
      } catch {
        for (const it of need)
          decisions.set(it.id, {
            decision: "escalate",
            confidence: 0,
            basis: "panel",
            reason: "panel call failed — escalated",
            groundingSources: it.grounding.sources,
          });
        process.stdout.write("v");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  if (batches.length) process.stdout.write("\n");

  const arr = [...decisions.values()];
  const report: VerifyReport = {
    total: decisions.size,
    corroborated: items.filter((it) => it.corroborated).length,
    panelKept: arr.filter((d) => d.decision === "keep").length,
    panelDropped: arr.filter((d) => d.decision === "drop").length,
    escalated: arr.filter((d) => d.decision === "escalate").length,
    decisions: Object.fromEntries(decisions),
  };
  return { decisions, report };
}

function applyVerdict(
  decisions: Map<string, Decision>,
  it: PanelItem & { id: string },
  v: { keep: boolean; confidence: number; reason: string },
) {
  const decision = v.confidence < KEEP_THRESHOLD ? "escalate" : v.keep ? "keep" : "drop";
  decisions.set(it.id, {
    decision,
    confidence: v.confidence,
    basis: it.grounding.sources.length === 0 && it.provenance.length === 0 ? "absent" : "panel",
    reason: v.reason,
    groundingSources: it.grounding.sources,
  });
}
