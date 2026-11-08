import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config";
import {
  readSegments,
  findSegmentForTime,
  captureSpan,
  type Segment,
} from "./timeline";

const execFileP = promisify(execFile);

export interface FrameResult {
  ok: boolean;
  path?: string;
  reason?: string;
}

/**
 * The C5 frame service: (capture-seconds, resolution) -> a JPEG on disk.
 * Output seeking (-ss after -i) for frame accuracy; segments are tiny so the decode is cheap.
 * `width` scales the longest edge (keep aspect, even dims); omit for native resolution.
 * Resolution presets used by the agent: ~512 (router), ~2576 (Opus hi-res single image).
 */
export async function getFrame(
  cfg: Config,
  t: number,
  opts: { width?: number; out: string },
): Promise<FrameResult> {
  const segs = await readSegments(cfg.segmentListPath);
  const span = captureSpan(segs);
  if (!span) return { ok: false, reason: "no_segments" };
  if (t < span.start || t >= span.end) {
    return {
      ok: false,
      reason: `t=${t} outside buffer [${span.start.toFixed(2)}, ${span.end.toFixed(2)})`,
    };
  }
  const seg = findSegmentForTime(segs, t);
  if (!seg) return { ok: false, reason: "gap_in_buffer" };

  // nudge off an exact segment boundary: output-seeking to offset 0 on an mpegts segment can
  // decode zero frames (the even-second failures we saw); 30ms in lands the same frame reliably.
  const offset = Math.max(0.03, t - seg.start);
  const vf = opts.width ? ["-vf", `scale=${opts.width}:-2`] : [];
  try {
    await execFileP("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      seg.file,
      "-ss",
      String(offset),
      "-frames:v",
      "1",
      ...vf,
      "-q:v",
      "2",
      "-y",
      opts.out,
    ]);
    return { ok: true, path: opts.out };
  } catch (e: any) {
    // file may have been reclaimed by the janitor between read and extract
    return { ok: false, reason: `extract_failed (reclaimed?): ${e.message}` };
  }
}

/** The C5 clip cutter: copy-concat the segments overlapping [t0, t1], then trim. */
export async function cutClip(
  cfg: Config,
  t0: number,
  t1: number,
  out: string,
): Promise<FrameResult> {
  const segs = await readSegments(cfg.segmentListPath);
  const overlap: Segment[] = segs.filter((s) => s.end > t0 && s.start < t1);
  if (overlap.length === 0)
    return { ok: false, reason: "no_segments_in_range" };

  const listText = overlap.map((s) => `file '${s.file}'`).join("\n");
  const { writeFile, unlink } = await import("node:fs/promises");
  const listPath = `${cfg.dataDir}/_cliplist_${Date.now()}.txt`;
  await writeFile(listPath, listText);
  try {
    await execFileP("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-ss",
      String(t0 - overlap[0].start),
      "-t",
      String(t1 - t0),
      "-c",
      "copy",
      "-y",
      out,
    ]);
    return { ok: true, path: out };
  } catch (e: any) {
    return { ok: false, reason: `clip_failed: ${e.message}` };
  } finally {
    await unlink(listPath).catch(() => {});
  }
}
