import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { embed, cosine } from "./embed";
import { buildBm25, scoreBm25, rrf } from "./bm25";
import { indexText, type Chunk } from "./build";
import { loadDotEnv } from "../ingest/env";

const kbRoot = join(import.meta.dirname, "..", "kb");

export interface AskResult {
  answer: string | null;
  passages: { score: number; chunk: Chunk }[];
  /** Max fused-rank signal; low → likely corpus gap, surfaced to caller. */
  topScore: number;
  retrieval: "hybrid";
}

function rankDesc(scores: number[]): number[] {
  return scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
}

/** Hybrid retrieve (dense + BM25, fused with RRF) → grounded answer. Embedding/retrieval are local; only the final answer uses Claude. */
export async function ask(
  game: string,
  question: string,
  opts: { k?: number; system?: string } = {},
): Promise<AskResult> {
  const k = opts.k ?? 8;
  const idx = JSON.parse(await readFile(join(kbRoot, game, "rag-index.json"), "utf8")) as {
    chunks: Chunk[];
    vectors: number[][];
  };

  // dense
  const [q] = await embed([question]);
  const denseScores = idx.vectors.map((v) => cosine(q, v));
  const denseRank = rankDesc(denseScores).slice(0, 50);

  // sparse (contextual BM25 over header+text, same text we embedded)
  const bm25 = buildBm25(idx.chunks.map(indexText));
  const sparseScores = scoreBm25(bm25, question);
  const sparseRank = rankDesc(sparseScores).slice(0, 50);

  // fuse — weight dense a bit higher (Anthropic's weighted fusion finding)
  const fused = rrf([denseRank, denseRank, sparseRank]); // dense listed twice ≈ ~0.66 weight
  const order = [...fused.entries()].sort((a, b) => b[1] - a[1]);

  const passages: { score: number; chunk: Chunk }[] = [];
  const seen = new Set<string>();
  for (const [id, score] of order) {
    const chunk = idx.chunks[id];
    const key = chunk.text.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    passages.push({ score, chunk });
    if (passages.length >= k) break;
  }
  const topScore = passages[0]?.score ?? 0;

  loadDotEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { answer: null, passages, topScore, retrieval: "hybrid" };

  const context = passages.map((p, i) => `[${i + 1}] (${p.chunk.sourceId}) ${indexText(p.chunk)}`).join("\n\n");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.COACH_RAG_MODEL ?? "claude-sonnet-4-6",
      max_tokens: 700,
      system:
        opts.system ??
        `You answer questions about the video game "${game}" using ONLY the provided context passages ` +
          `(retrieved from wikis, walkthroughs, and a knowledge graph). Cite passage numbers like [2]. ` +
          `Be concise and concrete. If the answer is not in the context, say so plainly rather than guessing.`,
      messages: [{ role: "user", content: `Context:\n${context}\n\nQuestion: ${question}` }],
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  const answer = (data.content ?? []).map((b: any) => b.text ?? "").join("");
  return { answer, passages, topScore, retrieval: "hybrid" };
}
