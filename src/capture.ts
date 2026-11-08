import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { Config } from "./config";
import { probeDeviceModes, pickMode, type PickedMode } from "./probe";

/**
 * Build the ffmpeg argv for the capture ring.
 *
 * Design notes:
 * - mpegts (.ts) segments, not mp4: a partially-written .ts is still decodable, so the ring is
 *   crash-survivable (an interrupted mp4 has no moov atom and is unreadable).
 * - keyframe-aligned to the segment boundary (-g + -force_key_frames) so frame seeks are accurate.
 * - h264_videotoolbox uses the Mac's hardware encoder -> low CPU, leaving headroom for analysis.
 * - segment_list CSV is the canonical timeline (C2): each row is `path,start_sec,end_sec`,
 *   start/end measured in cumulative capture-seconds from the start of capture.
 */
export function buildCaptureArgs(cfg: Config, deviceMode?: PickedMode): string[] {
  const out = `${cfg.segmentDir}/seg_%Y%m%d_%H%M%S.ts`;
  const common = ["-hide_banner", "-loglevel", "warning"];

  let input: string[];
  switch (cfg.source.kind) {
    case "test":
      input = [
        "-re",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=${cfg.width}x${cfg.height}:rate=${cfg.fps},format=yuv420p`,
      ];
      break;
    case "file":
      if (!cfg.source.filePath)
        throw new Error("source.filePath required for kind=file");
      input = ["-stream_loop", "-1", "-re", "-i", cfg.source.filePath];
      break;
    case "device":
      if (cfg.source.deviceIndex == null)
        throw new Error("source.deviceIndex required for kind=device");
      // avfoundation defaults to 29.97fps, which most capture cards reject. Pass the
      // probed native mode (-framerate/-video_size, both input options → before -i).
      // -use_wallclock_as_timestamps re-stamps frames monotonically: many capture cards
      // (and webcams) emit broken/zero DTS that otherwise stall the segment muxer.
      input = ["-f", "avfoundation", "-use_wallclock_as_timestamps", "1"];
      if (deviceMode) {
        input.push("-framerate", String(deviceMode.fps), "-video_size", `${deviceMode.width}x${deviceMode.height}`);
      }
      input.push("-i", cfg.source.deviceIndex);
      break;
  }

  // GOP must track the real stream fps so segment boundaries stay keyframe-aligned.
  const effFps = cfg.source.kind === "device" && deviceMode ? deviceMode.fps : cfg.fps;
  // Force CFR on device capture so wallclock-stamped input becomes an even, muxable cadence.
  const tsFix = cfg.source.kind === "device" ? ["-fps_mode", "cfr", "-r", String(effFps)] : [];
  const encode = [
    "-c:v",
    "h264_videotoolbox",
    "-b:v",
    cfg.bitrate,
    ...tsFix,
    "-g",
    String(effFps * cfg.segmentSeconds),
    "-force_key_frames",
    `expr:gte(t,n_forced*${cfg.segmentSeconds})`,
    "-an", // no audio in the prototype ring
  ];

  const segment = [
    "-f",
    "segment",
    "-segment_time",
    String(cfg.segmentSeconds),
    "-segment_format",
    "mpegts",
    "-reset_timestamps",
    "1",
    "-strftime",
    "1",
    "-segment_list",
    cfg.segmentListPath,
    "-segment_list_type",
    "csv",
    "-segment_list_flags",
    "+live",
    out,
  ];

  return [...common, ...input, ...encode, ...segment];
}

export async function startCapture(cfg: Config): Promise<ChildProcess> {
  await mkdir(cfg.segmentDir, { recursive: true });
  let mode: PickedMode | undefined;
  if (cfg.source.kind === "device") {
    const modes = await probeDeviceModes(cfg.source.deviceIndex!);
    mode = pickMode(modes) ?? undefined;
    if (mode) console.error(`[capture] device ${cfg.source.deviceIndex}: ${mode.width}x${mode.height}@${mode.fps}fps`);
    else console.error(`[capture] device ${cfg.source.deviceIndex}: no mode probed; letting avfoundation negotiate`);
  }
  const args = buildCaptureArgs(cfg, mode);
  // inherit stderr so ffmpeg warnings (incl. avfoundation permission errors) are visible.
  return spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
}
