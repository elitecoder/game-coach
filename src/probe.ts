import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface DeviceMode {
  width: number;
  height: number;
  fpsOptions: number[];
}

/** avfoundation advertises a device's supported modes on stderr when asked for an
 *  impossible framerate. We trigger that, parse it, and pick the best mode — so
 *  `--source=device:N` works without the caller knowing the card's native modes
 *  (the MS2130 dongle only does 60/30, the FaceTime cam only 30/15, etc). */
export function parseModes(stderr: string): DeviceMode[] {
  const modes: DeviceMode[] = [];
  for (const line of stderr.split("\n")) {
    const m = /(\d+)x(\d+)@\[([0-9.\s]+)\]fps/.exec(line);
    if (!m) continue;
    const fpsOptions = m[3]
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => !Number.isNaN(n) && n > 0);
    if (fpsOptions.length) modes.push({ width: +m[1], height: +m[2], fpsOptions });
  }
  return modes;
}

export async function probeDeviceModes(index: string): Promise<DeviceMode[]> {
  let stderr = "";
  try {
    // framerate 1 is below every device's minimum → forces the supported-modes dump
    await execFileP("ffmpeg", [
      "-hide_banner",
      "-f",
      "avfoundation",
      "-framerate",
      "1",
      "-i",
      index,
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ]);
  } catch (e: any) {
    stderr = e.stderr ?? "";
  }
  return parseModes(stderr);
}

export interface PickedMode {
  width: number;
  height: number;
  fps: number;
}

/** Prefer the largest landscape resolution within the cap, then the highest fps. */
export function pickMode(modes: DeviceMode[], maxW = 1920, maxH = 1080): PickedMode | null {
  const ok = modes.filter((m) => m.width <= maxW && m.height <= maxH && m.width >= m.height);
  if (!ok.length) return null;
  ok.sort(
    (a, b) => b.width * b.height - a.width * a.height || Math.max(...b.fpsOptions) - Math.max(...a.fpsOptions),
  );
  const best = ok[0];
  return { width: best.width, height: best.height, fps: Math.max(...best.fpsOptions) };
}
