import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultConfig, type CaptureSource, type Config } from "./config";
import { runDaemon } from "./daemon";
import { getFrame, cutClip } from "./frames";
import { getHealth } from "./health";
import { runJanitor, setWatermark } from "./retention";
import { runCompactor } from "./compactor";
import { readSegments, captureSpan } from "./timeline";

const execFileP = promisify(execFile);

function parseFlags(argv: string[]): {
  positional: string[];
  flags: Record<string, string>;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      flags[k] = v ?? "true";
    } else positional.push(a);
  }
  return { positional, flags };
}

function sourceFromFlag(s: string | undefined): CaptureSource {
  if (!s || s === "test") return { kind: "test" };
  if (s.startsWith("device:")) return { kind: "device", deviceIndex: s.slice(7) };
  if (s.startsWith("file:")) return { kind: "file", filePath: s.slice(5) };
  throw new Error(`bad --source '${s}' (use test | device:N | file:/path)`);
}

function cfgFromFlags(flags: Record<string, string>): Config {
  const overrides: Partial<Config> = {};
  if (flags.data) overrides.dataDir = flags.data;
  if (flags.source) overrides.source = sourceFromFlag(flags.source);
  if (flags.width) overrides.width = Number(flags.width);
  if (flags.height) overrides.height = Number(flags.height);
  if (flags.fps) overrides.fps = Number(flags.fps);
  return defaultConfig(overrides);
}

async function listDevices(): Promise<void> {
  // ffmpeg prints the device list to stderr and exits non-zero by design.
  try {
    await execFileP("ffmpeg", [
      "-hide_banner",
      "-f",
      "avfoundation",
      "-list_devices",
      "true",
      "-i",
      "",
    ]);
  } catch (e: any) {
    process.stdout.write(e.stderr ?? String(e));
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);
  const cfg = cfgFromFlags(flags);

  switch (cmd) {
    case "list-devices":
      await listDevices();
      break;

    case "start":
      await runDaemon(cfg);
      break;

    case "status": {
      const health = await getHealth(cfg);
      console.log(JSON.stringify(health, null, 2));
      break;
    }

    case "get-frame": {
      const t = Number(positional[0]);
      if (Number.isNaN(t)) throw new Error("usage: get-frame <captureSeconds> [--width=N] [--out=PATH]");
      const out = flags.out ?? `${cfg.dataDir}/frame_${t}.jpg`;
      const r = await getFrame(cfg, t, {
        width: flags.width ? Number(flags.width) : undefined,
        out,
      });
      console.log(JSON.stringify(r, null, 2));
      if (!r.ok) process.exitCode = 1; // surface failures instead of exiting 0 silently
      break;
    }

    case "clip": {
      const t0 = Number(positional[0]);
      const t1 = Number(positional[1]);
      if (Number.isNaN(t0) || Number.isNaN(t1))
        throw new Error("usage: clip <t0> <t1> [--out=PATH]");
      const out = flags.out ?? `${cfg.dataDir}/clip_${t0}_${t1}.ts`;
      const r = await cutClip(cfg, t0, t1, out);
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    case "watermark": {
      // simulate a consumer (e.g. the progression-extraction pass) reporting analysis progress
      const consumer = positional[0];
      const t = Number(positional[1]);
      if (!consumer || Number.isNaN(t))
        throw new Error("usage: watermark <consumerId> <captureSeconds>");
      const wm = await setWatermark(cfg.watermarksPath, consumer, t);
      console.log(JSON.stringify(wm, null, 2));
      break;
    }

    case "gc": {
      const segs = await readSegments(cfg.segmentListPath);
      const span = captureSpan(segs);
      const r = await runJanitor(cfg, span?.end ?? 0);
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    case "compact": {
      const segs = await readSegments(cfg.segmentListPath);
      const span = captureSpan(segs);
      const max = flags.max ? Number(flags.max) : Number.MAX_SAFE_INTEGER;
      const r = await runCompactor(cfg, span?.end ?? 0, { max });
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    default:
      console.log(
        [
          "coach-capture — game-coach capture daemon foundation",
          "",
          "commands:",
          "  list-devices                       list avfoundation video devices (find your capture card index)",
          "  start [--source=...] [--data=DIR]  start capture + retention janitor (Ctrl-C to stop)",
          "       --source=test                 ffmpeg test pattern (default, no hardware)",
          "       --source=file:/path/vid.mp4   loop a local gameplay video",
          "       --source=device:0             an avfoundation device (your capture card)",
          "  status [--data=DIR]                capture-health + buffer span",
          "  get-frame <t> [--width=N] [--out=] extract a JPEG at capture-second t",
          "  clip <t0> <t1> [--out=]            cut a clip [t0,t1]",
          "  watermark <consumer> <t>           advance a consumer's analyzed-watermark (retention)",
          "  gc                                 run the retention janitor once and report",
        ].join("\n"),
      );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
