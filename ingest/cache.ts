import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Segment, Fragment } from "./types";

/** Content-addressed fragment cache: extraction is paid for once per (game, segment content, model).
 *  Makes re-runs after a downstream bug free — no repeated VLM spend. */
export function fragKey(game: string, seg: Segment, model: string): string {
  return createHash("sha256")
    .update([game, model, seg.transcript, seg.keyframePaths.join(",")].join("|"))
    .digest("hex")
    .slice(0, 32);
}

export async function getCached(dir: string, key: string): Promise<Fragment | null> {
  try {
    return JSON.parse(await readFile(join(dir, `${key}.json`), "utf8")) as Fragment;
  } catch {
    return null;
  }
}

export async function putCached(dir: string, key: string, frag: Fragment): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${key}.json`), JSON.stringify(frag));
}
