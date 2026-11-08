import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Config } from "./config";
import { readSegments } from "./timeline";

const execFileP = promisify(execFile);

/**
 * Compaction (plan §5.1 "analysis proxy" hook): old footage only needs to be good enough to
 * extract single frames from (boss banners, area titles, menu reads) — not 1080p60/12Mbps for
 * live coaching. So segments older than cfg.compactAgeSeconds are re-encoded in place to a small
 * proxy (lower res / fps / bitrate). The timeline (segments.csv) is untouched: we overwrite each
 * .ts atomically at the same path and capture-second range, so getFrame/cutClip keep working —
 * they just decode a lighter file. A sidecar manifest records what's already compacted.
 */

async function loadManifest(path: string): Promise<Set<string>> {
  try {
    return new Set(JSON.parse(await readFile(path, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

export interface CompactResult {
  compacted: number;
  skipped: number;
  eligible: number;
  bytesSaved: number;
}

export async function runCompactor(
  cfg: Config,
  liveEdgeSec: number,
  opts: { max?: number } = {},
): Promise<CompactResult> {
  if (!cfg.compactEnabled) return { compacted: 0, skipped: 0, eligible: 0, bytesSaved: 0 };

  const segs = await readSegments(cfg.segmentListPath);
  const done = await loadManifest(cfg.compactedManifestPath);
  const cutoff = liveEdgeSec - cfg.compactAgeSeconds;
  // oldest-first, only fully-aged segments we haven't already compacted
  const eligible = segs.filter((s) => s.end <= cutoff && !done.has(basename(s.file)));
  const batch = eligible.slice(0, opts.max ?? cfg.compactBatchPerTick);

  let compacted = 0;
  let skipped = 0;
  let bytesSaved = 0;

  for (const s of batch) {
    const bn = basename(s.file);
    let before: number;
    try {
      before = (await stat(s.file)).size;
    } catch {
      done.add(bn); // file already gone (reclaimed) — never revisit
      continue;
    }
    const tmp = `${s.file}.prx.ts`;
    try {
      await execFileP("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        s.file,
        "-vf",
        `scale=${cfg.proxyWidth}:-2`,
        "-r",
        String(cfg.proxyFps),
        "-c:v",
        "h264_videotoolbox",
        "-b:v",
        cfg.proxyBitrate,
        "-an",
        "-f",
        "mpegts",
        "-y",
        tmp,
      ]);
      const after = (await stat(tmp)).size;
      if (after < before) {
        await rename(tmp, s.file); // atomic: getFrame readers see old OR new, both valid
        bytesSaved += before - after;
        compacted++;
      } else {
        await unlink(tmp).catch(() => {}); // proxy not smaller (rare) — keep original
        skipped++;
      }
      done.add(bn);
    } catch {
      skipped++;
      await unlink(tmp).catch(() => {});
    }
  }

  await writeFile(cfg.compactedManifestPath, JSON.stringify([...done]));
  return { compacted, skipped, eligible: eligible.length, bytesSaved };
}
