import { readFile } from "node:fs/promises";
import type { Acquired, Segment } from "./types";

interface Cue {
  start: number;
  end: number;
  text: string;
}

function srtTimeToSec(s: string): number {
  const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

export async function parseSrt(path: string | undefined): Promise<Cue[]> {
  if (!path) return [];
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const cues: Cue[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const tl = lines.find((l) => l.includes("-->"));
    if (!tl) continue;
    const [a, b] = tl.split("-->");
    const textLines = lines.slice(lines.indexOf(tl) + 1);
    cues.push({
      start: srtTimeToSec(a),
      end: srtTimeToSec(b),
      text: textLines.join(" ").replace(/<[^>]+>/g, "").trim(),
    });
  }
  return cues;
}

function transcriptFor(cues: Cue[], start: number, end: number): string {
  return cues
    .filter((c) => c.start >= start - 0.5 && c.start < end)
    .map((c) => c.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const FALLBACK_WINDOW_SEC = 90;

/**
 * Segment a source into entity-aligned chunks (§7.2 step 2): prefer creator chapter markers
 * ("Phase 2", "Path to the Citadel" — free structure); fall back to fixed windows when absent.
 */
export async function segment(acq: Acquired): Promise<Segment[]> {
  const cues = await parseSrt(acq.subtitlePath);

  let spans: { start: number; end: number; title: string }[];
  if (acq.chapters.length > 0) {
    spans = acq.chapters.map((c) => ({
      start: c.startSec,
      end: c.endSec,
      title: c.title,
    }));
  } else {
    const dur = acq.durationSec || (cues.at(-1)?.end ?? 0);
    spans = [];
    for (let s = 0; s < dur; s += FALLBACK_WINDOW_SEC) {
      spans.push({
        start: s,
        end: Math.min(s + FALLBACK_WINDOW_SEC, dur),
        title: `window ${Math.floor(s / FALLBACK_WINDOW_SEC) + 1}`,
      });
    }
  }

  return spans.map((sp, i) => ({
    sourceId: acq.sourceId,
    videoId: acq.videoId,
    index: i,
    startSec: sp.start,
    endSec: sp.end,
    title: sp.title,
    transcript: transcriptFor(cues, sp.start, sp.end),
    keyframePaths: [],
  }));
}
