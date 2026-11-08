import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { embed, EMBED_MODEL } from "./embed";
import { contextualizeAll, type CtxJob } from "./contextualize";
import { loadDotEnv } from "../ingest/env";
import type { GameGraph } from "../kb/schema";

const kbRoot = join(import.meta.dirname, "..", "kb");

export interface Chunk {
  id: string;
  sourceId: string;
  kind: "corpus" | "entity";
  text: string;
  /** Anthropic-style situating header (empty for entity cards / when context off). */
  context?: string;
}

function chunkText(text: string, size = 600, overlap = 120): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += size - overlap) out.push(clean.slice(i, i + size));
  return out.filter((c) => c.trim().length > 40);
}

/** Prose corpus: wiki text + video transcripts, windowed for retrieval. Also returns full doc text per source for contextualization. */
async function corpusChunks(gameDir: string): Promise<{ chunks: Chunk[]; docBySource: Record<string, string> }> {
  const rawDir = join(gameDir, "_raw");
  const out: Chunk[] = [];
  const docBySource: Record<string, string> = {};
  let dirs: string[] = [];
  try {
    dirs = await readdir(rawDir);
  } catch {
    return { chunks: out, docBySource };
  }
  for (const sid of dirs) {
    let files: string[] = [];
    try {
      files = await readdir(join(rawDir, sid));
    } catch {
      continue;
    }
    let text = "";
    for (const f of files)
      if (f.endsWith("page.txt") || f.endsWith(".srt")) {
        try {
          text += "\n" + (await readFile(join(rawDir, sid, f), "utf8"));
        } catch {
          /* skip */
        }
      }
    docBySource[sid] = text.replace(/\s+/g, " ").trim();
    chunkText(text).forEach((c, i) => out.push({ id: `${sid}#${i}`, sourceId: sid, kind: "corpus", text: c }));
  }
  return { chunks: out, docBySource };
}

/** Graph entity cards: make the structured relationships retrievable as text. */
function entityCards(graph: GameGraph): Chunk[] {
  const zoneName = (id: string) => graph.zones.find((z) => z.id === id)?.name ?? id;
  const cards: Chunk[] = [];
  for (const z of graph.zones) {
    const conns = graph.connectors
      .filter((c) => c.fromZone === z.id || c.toZone === z.id)
      .map((c) => `${zoneName(c.fromZone)} <-> ${zoneName(c.toZone)}`);
    cards.push({ id: z.id, sourceId: "graph", kind: "entity", text: `Zone: ${z.name}. ${z.fingerprintHint ?? ""} Connections: ${conns.join(", ")}` });
  }
  for (const b of graph.bosses)
    cards.push({ id: b.id, sourceId: "graph", kind: "entity", text: `Boss: ${b.name} (in ${zoneName(b.zone)}). ${b.note ?? ""}` });
  for (const a of graph.abilities)
    cards.push({ id: a.id, sourceId: "graph", kind: "entity", text: `${a.type === "ability" ? "Ability" : "Item"}: ${a.name} (acquired in ${zoneName(a.acquiredAtZone)}). ${a.note ?? ""}` });
  for (const o of graph.objectives)
    cards.push({ id: o.id, sourceId: "graph", kind: "entity", text: `Objective: ${o.name}. ${o.hopDescription}` });
  return cards;
}

/** Text embedded/indexed for a chunk = situating header + raw window (contextual embeddings + contextual BM25). */
export function indexText(c: Chunk): string {
  return c.context ? `${c.context}\n${c.text}` : c.text;
}

export async function buildIndex(game: string, opts: { context?: boolean } = {}): Promise<number> {
  const gameDir = join(kbRoot, game);
  const graph = JSON.parse(await readFile(join(gameDir, "graph.ingested.json"), "utf8")) as GameGraph;
  const { chunks: corpus, docBySource } = await corpusChunks(gameDir);

  // #1 Contextual headers (corpus only; entity cards already self-describing).
  loadDotEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const wantCtx = opts.context !== false && !!apiKey;
  if (wantCtx) {
    const jobs: CtxJob[] = corpus.map((c) => ({ sourceId: c.sourceId, chunkText: c.text }));
    console.log(`[rag] ${game}: generating contextual headers for ${jobs.length} corpus chunks...`);
    const headers = await contextualizeAll(apiKey!, docBySource, jobs, join(gameDir, "_ctxcache"));
    corpus.forEach((c, i) => (c.context = headers[i] || undefined));
  } else if (opts.context !== false) {
    console.log(`[rag] ${game}: no ANTHROPIC_API_KEY — skipping contextual headers (raw chunks only).`);
  }

  const chunks = [...corpus, ...entityCards(graph)];
  console.log(`[rag] ${game}: embedding ${chunks.length} chunks (corpus + graph cards)...`);
  const vectors = await embed(chunks.map(indexText));
  await writeFile(
    join(gameDir, "rag-index.json"),
    JSON.stringify({ model: EMBED_MODEL, dim: vectors[0]?.length ?? 0, contextual: wantCtx, chunks, vectors }),
  );
  return chunks.length;
}
