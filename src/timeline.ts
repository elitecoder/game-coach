import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/** One ring segment, addressed on the canonical capture-seconds clock (C2). */
export interface Segment {
  file: string;
  start: number; // capture-seconds (cumulative from capture start)
  end: number;
}

/**
 * Read ffmpeg's segment_list CSV. Format per row: `path,start_sec,end_sec`.
 * The CSV is append-only and owned by ffmpeg; we only ever read it.
 * Rows whose files have been reclaimed by the janitor are tolerated downstream
 * (getFrame returns a clean "reclaimed" reason rather than crashing).
 */
export async function readSegments(segmentListPath: string): Promise<Segment[]> {
  let text: string;
  try {
    text = await readFile(segmentListPath, "utf8");
  } catch {
    return [];
  }
  // ffmpeg writes basenames in the CSV; resolve them against the segment dir.
  const baseDir = dirname(segmentListPath);
  const segs: Segment[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(",");
    if (parts.length < 3) continue;
    const [file, start, end] = parts;
    const s = Number(start);
    const e = Number(end);
    if (!file || Number.isNaN(s) || Number.isNaN(e)) continue;
    segs.push({
      file: isAbsolute(file) ? file : join(baseDir, file),
      start: s,
      end: e,
    });
  }
  return segs;
}

export function findSegmentForTime(
  segs: Segment[],
  t: number,
): Segment | null {
  for (const s of segs) if (t >= s.start && t < s.end) return s;
  return null;
}

export function captureSpan(
  segs: Segment[],
): { start: number; end: number } | null {
  if (segs.length === 0) return null;
  return { start: segs[0].start, end: segs[segs.length - 1].end };
}
