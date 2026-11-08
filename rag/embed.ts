import { pipeline } from "@huggingface/transformers";

export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

let extractorP: Promise<any> | null = null;
function getExtractor() {
  return (extractorP ??= pipeline("feature-extraction", EMBED_MODEL));
}

/** Local sentence embeddings (no API key). Mean-pooled + L2-normalized → cosine = dot product. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const ex = await getExtractor();
  const out: number[][] = [];
  const B = 32;
  for (let i = 0; i < texts.length; i += B) {
    const batch = texts.slice(i, i + B);
    const res = await ex(batch, { pooling: "mean", normalize: true });
    for (const v of res.tolist() as number[][]) out.push(v);
    if (texts.length > 200) process.stdout.write(`\r[embed] ${Math.min(i + B, texts.length)}/${texts.length}`);
  }
  if (texts.length > 200) process.stdout.write("\n");
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
