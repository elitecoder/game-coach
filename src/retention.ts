import { readFile, writeFile, unlink, stat } from "node:fs/promises";
import type { Config } from "./config";
import { readSegments } from "./timeline";

/** consumerId -> the capture-second up to which that consumer has fully analyzed the media. */
export type Watermarks = Record<string, number>;

export async function readWatermarks(path: string): Promise<Watermarks> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Watermarks;
  } catch {
    return {};
  }
}

/** Watermarks are monotonic: a consumer can only ever advance its high-water mark. */
export async function setWatermark(
  path: string,
  consumer: string,
  t: number,
): Promise<Watermarks> {
  const wm = await readWatermarks(path);
  wm[consumer] = Math.max(wm[consumer] ?? 0, t);
  await writeFile(path, JSON.stringify(wm, null, 2));
  return wm;
}

export interface GcResult {
  reclaimed: string[];
  keptSegments: number;
  minWatermark: number | null;
  reclaimBefore: number | null;
  diskGB: number;
  overCeiling: boolean;
  reason: string;
}

async function dirSizeGB(files: string[]): Promise<number> {
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += (await stat(f)).size;
    } catch {
      /* reclaimed */
    }
  }
  return bytes / 1e9;
}

/**
 * Retain-until-analyzed janitor (plan §5.1).
 *
 * INVARIANT: never reclaim un-analyzed media. A segment is reclaimable only if it is at or below
 * EVERY registered consumer's watermark AND older than the live-coaching window. With no consumer
 * registered, nothing is reclaimed — we retain all media until something has analyzed it.
 *
 * Disk safety valve: we report disk usage and an over-ceiling flag. We do NOT blind-delete to get
 * under the ceiling (that would violate the invariant). The intended response to over-ceiling is to
 * force/accelerate the extraction pass (raising watermarks) or transcode the oldest un-analyzed span
 * to a low-bitrate analysis proxy — both TODO hooks.
 */
export async function runJanitor(
  cfg: Config,
  nowCaptureEnd: number,
): Promise<GcResult> {
  const segs = await readSegments(cfg.segmentListPath);
  const wm = await readWatermarks(cfg.watermarksPath);
  const consumers = Object.keys(wm);
  const diskGB = await dirSizeGB(segs.map((s) => s.file));
  const overCeiling = diskGB > cfg.diskCeilingGB;

  if (consumers.length === 0) {
    return {
      reclaimed: [],
      keptSegments: segs.length,
      minWatermark: null,
      reclaimBefore: null,
      diskGB,
      overCeiling,
      reason: "no_consumers_registered:retain_all_until_analyzed",
    };
  }

  const minWm = Math.min(...consumers.map((c) => wm[c]));
  const liveFloor = nowCaptureEnd - cfg.liveWindowSeconds;
  const reclaimBefore = Math.min(minWm, liveFloor);

  const reclaimed: string[] = [];
  for (const s of segs) {
    if (s.end <= reclaimBefore) {
      try {
        await unlink(s.file);
        reclaimed.push(s.file);
      } catch {
        /* already gone */
      }
    }
  }

  return {
    reclaimed,
    keptSegments: segs.length - reclaimed.length,
    minWatermark: minWm,
    reclaimBefore,
    diskGB,
    overCeiling,
    reason: overCeiling
      ? "ok:OVER_DISK_CEILING_force_extraction_or_proxy_TODO"
      : "ok",
  };
}
