import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadDotEnv } from "./env";

export interface Verdict {
  belongsToGame: boolean;
  isRealEntity: boolean;
  confidence: number;
}

export interface SweepEntity {
  id: string;
  name: string;
  kind: string;
}

const MODEL = process.env.COACH_SWEEP_MODEL ?? "claude-haiku-4-5";

const TOOL = {
  name: "classify_entities",
  description: "Return a verdict for every candidate entity.",
  input_schema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ref: { type: "integer" },
            belongsToGame: { type: "boolean" },
            isRealEntity: { type: "boolean" },
            confidence: { type: "number" },
          },
          required: ["ref", "belongsToGame", "isRealEntity", "confidence"],
        },
      },
    },
    required: ["verdicts"],
  },
} as const;

async function classifyBatch(
  game: string,
  batch: { ref: number; name: string; kind: string }[],
): Promise<Record<number, Verdict>> {
  const key = process.env.ANTHROPIC_API_KEY!;
  const list = batch.map((b) => `[${b.ref}] (${b.kind}) ${b.name}`).join("\n");
  const system =
    `You audit an auto-extracted knowledge graph for the video game "${game}". For EACH candidate ` +
    `entity decide:\n` +
    `- belongsToGame: true if it is genuinely an entity FROM ${game}; false if it is contamination ` +
    `from a DIFFERENT game (common with same-genre titles) or otherwise not part of ${game}.\n` +
    `- isRealEntity: true if it is a real named entity; false if it is a vague descriptor or hedge ` +
    `(e.g. "Powerful new ability", "Prior to Metropolis", "Bosses (general)", "Unknown Area", ` +
    `"First ability (Dwellings)").\n` +
    `- confidence: 0..1 in your judgement.\n` +
    `Be strict about cross-game contamination. Return exactly one verdict per ref.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "classify_entities" },
      system,
      messages: [{ role: "user", content: `Entities:\n${list}` }],
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  const tu = (data.content ?? []).find((b: any) => b.type === "tool_use");
  const out: Record<number, Verdict> = {};
  for (const v of tu?.input?.verdicts ?? []) {
    out[v.ref] = {
      belongsToGame: !!v.belongsToGame,
      isRealEntity: !!v.isRealEntity,
      confidence: Number(v.confidence) || 0,
    };
  }
  return out;
}

const vKey = (game: string, name: string, kind: string) =>
  createHash("sha256").update([game, MODEL, kind, name].join("|")).digest("hex").slice(0, 32);

/** Classify every entity for game-membership + real-vs-descriptor. Cached per entity; fail-open
 *  (on API error an entity is kept) so a hiccup never nukes the graph. */
export async function llmSweep(
  game: string,
  entities: SweepEntity[],
  cacheDir: string,
  batchSize = 35,
  concurrency = 4,
): Promise<Map<string, Verdict>> {
  loadDotEnv();
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("llmSweep requires ANTHROPIC_API_KEY");
  await mkdir(cacheDir, { recursive: true });

  const result = new Map<string, Verdict>();
  const need: SweepEntity[] = [];
  for (const e of entities) {
    try {
      result.set(e.id, JSON.parse(await readFile(join(cacheDir, vKey(game, e.name, e.kind) + ".json"), "utf8")));
    } catch {
      need.push(e);
    }
  }

  const batches: SweepEntity[][] = [];
  for (let i = 0; i < need.length; i += batchSize) batches.push(need.slice(i, i + batchSize));

  let bi = 0;
  const worker = async () => {
    while (bi < batches.length) {
      const b = batches[bi++];
      const refMap = b.map((e, i) => ({ ref: i, ...e }));
      try {
        const verdicts = await classifyBatch(game, refMap);
        for (const r of refMap) {
          const v = verdicts[r.ref] ?? { belongsToGame: true, isRealEntity: true, confidence: 0 };
          result.set(r.id, v);
          await writeFile(join(cacheDir, vKey(game, r.name, r.kind) + ".json"), JSON.stringify(v));
        }
        process.stdout.write("S");
      } catch {
        for (const r of refMap) result.set(r.id, { belongsToGame: true, isRealEntity: true, confidence: 0 });
        process.stdout.write("s");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  process.stdout.write("\n");
  return result;
}
