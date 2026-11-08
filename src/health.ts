import { stat } from "node:fs/promises";
import type { Config } from "./config";
import { readSegments, captureSpan } from "./timeline";

/** Capture-health (C4): honest signal state, never a black frame masquerading as good. */
export interface Health {
  signalPresent: boolean;
  segmentCount: number;
  bufferStartSec: number | null;
  bufferEndSec: number | null;
  bufferDurationSec: number | null;
  /** wall-clock seconds since the newest segment file was last written. */
  lastSegmentAgeSec: number | null;
  note: string;
}

export async function getHealth(cfg: Config): Promise<Health> {
  const segs = await readSegments(cfg.segmentListPath);
  const span = captureSpan(segs);
  if (!span) {
    return {
      signalPresent: false,
      segmentCount: 0,
      bufferStartSec: null,
      bufferEndSec: null,
      bufferDurationSec: null,
      lastSegmentAgeSec: null,
      note: "no_segments_yet",
    };
  }

  // age of the newest segment on disk = liveness signal. If capture stalls (no signal,
  // HDCP, unplugged card) ffmpeg stops emitting segments and this age grows.
  let lastAge: number | null = null;
  for (let i = segs.length - 1; i >= 0; i--) {
    try {
      const st = await stat(segs[i].file);
      lastAge = (Date.now() - st.mtimeMs) / 1000;
      break;
    } catch {
      // reclaimed; keep walking back
    }
  }

  const stale = lastAge == null || lastAge > cfg.segmentSeconds * 3;
  return {
    signalPresent: !stale,
    segmentCount: segs.length,
    bufferStartSec: span.start,
    bufferEndSec: span.end,
    bufferDurationSec: span.end - span.start,
    lastSegmentAgeSec: lastAge,
    note: stale
      ? "stale: capture not advancing (no signal / unplugged / permission?)"
      : "ok",
  };
}
