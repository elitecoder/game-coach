/** Minimal BM25 over the corpus. Sparse/lexical retrieval: catches exact entity
 * names (Mantis Lords vs Mantis Claw vs Mantis Youths) that a dense model blurs. */

const K1 = 1.5;
const B = 0.75;

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);
}

export interface Bm25Index {
  N: number;
  avgdl: number;
  df: Map<string, number>;
  docs: { len: number; tf: Map<string, number> }[];
}

export function buildBm25(texts: string[]): Bm25Index {
  const docs = texts.map((t) => {
    const toks = tokenize(t);
    const tf = new Map<string, number>();
    for (const w of toks) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { len: toks.length, tf };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
  return { N: docs.length, avgdl, df, docs };
}

/** Score every doc against the query. Returns array aligned to texts order. */
export function scoreBm25(idx: Bm25Index, query: string): number[] {
  const qToks = [...new Set(tokenize(query))];
  const idf = new Map<string, number>();
  for (const w of qToks) {
    const n = idx.df.get(w) ?? 0;
    // BM25+ idf, floored at 0 so common terms never go negative
    idf.set(w, Math.max(0, Math.log((idx.N - n + 0.5) / (n + 0.5) + 1)));
  }
  return idx.docs.map((d) => {
    let s = 0;
    for (const w of qToks) {
      const f = d.tf.get(w);
      if (!f) continue;
      const denom = f + K1 * (1 - B + (B * d.len) / idx.avgdl);
      s += (idf.get(w) ?? 0) * ((f * (K1 + 1)) / denom);
    }
    return s;
  });
}

/** Reciprocal Rank Fusion of several ranked id-lists (best-first). k=60 is the standard default. */
export function rrf(rankedLists: number[][], k = 60): Map<number, number> {
  const fused = new Map<number, number>();
  for (const list of rankedLists) {
    list.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return fused;
}
