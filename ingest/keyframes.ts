import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Acquired, Segment } from "./types";

const execFileP = promisify(execFile);

/**
 * Sample K keyframes evenly across each segment (§7.2 step 3). These are the visual evidence the
 * VLM extracts from — and the same kind of reference keyframes the play-time coach later matches
 * the player's frames against. Scaled to 768px (plenty for VLM, cheap on tokens).
 */
export async function sampleKeyframes(
  acq: Acquired,
  segments: Segment[],
  keyframeDir: string,
  perSegment = 3,
): Promise<Segment[]> {
  const dir = join(keyframeDir, acq.sourceId);
  await mkdir(dir, { recursive: true });

  for (const seg of segments) {
    const span = Math.max(0, seg.endSec - seg.startSec);
    const paths: string[] = [];
    for (let k = 0; k < perSegment; k++) {
      // sample at the 1/(K+1) ... K/(K+1) points to avoid hard cut frames at boundaries
      const t = seg.startSec + (span * (k + 1)) / (perSegment + 1);
      const out = join(
        dir,
        `seg${String(seg.index).padStart(2, "0")}_f${k}.jpg`,
      );
      try {
        await execFileP("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          String(t),
          "-i",
          acq.videoPath,
          "-frames:v",
          "1",
          "-vf",
          "scale=768:-2",
          "-q:v",
          "3",
          "-y",
          out,
        ]);
        paths.push(out);
      } catch {
        // skip a frame we couldn't pull (e.g., past EOF on a short segment)
      }
    }
    seg.keyframePaths = paths;
  }
  return segments;
}
