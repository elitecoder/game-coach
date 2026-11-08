import type { Config } from "./config";
import { startCapture } from "./capture";
import { runJanitor } from "./retention";
import { runCompactor } from "./compactor";
import { readSegments, captureSpan } from "./timeline";

/** Long-running daemon: owns the capture process + the retention janitor loop. */
export async function runDaemon(cfg: Config): Promise<void> {
  const proc = await startCapture(cfg);
  console.log(
    `[daemon] capture started (source=${cfg.source.kind}) -> ${cfg.segmentDir}`,
  );
  if (cfg.source.kind === "device") {
    console.log(
      "[daemon] NOTE: macOS requires Camera permission for the terminal/app to read a capture card.",
    );
  }

  proc.on("exit", (code) => {
    console.log(`[daemon] ffmpeg exited code=${code}`);
    clearInterval(tick);
    process.exit(code ?? 0);
  });

  const tick = setInterval(async () => {
    const segs = await readSegments(cfg.segmentListPath);
    const span = captureSpan(segs);
    if (!span) return;
    const gc = await runJanitor(cfg, span.end);
    if (gc.reclaimed.length > 0) {
      console.log(
        `[janitor] reclaimed ${gc.reclaimed.length} seg(s) (minWatermark=${gc.minWatermark?.toFixed(1)}, disk=${gc.diskGB.toFixed(2)}GB)`,
      );
    }
    if (gc.overCeiling) {
      console.warn(
        `[janitor] OVER DISK CEILING (${gc.diskGB.toFixed(1)}GB > ${cfg.diskCeilingGB}GB) — extraction must catch up; not blind-deleting un-analyzed media.`,
      );
    }
    // compress media older than the live window down to an analysis proxy
    const cp = await runCompactor(cfg, span.end);
    if (cp.compacted > 0) {
      console.log(
        `[compactor] compressed ${cp.compacted} seg(s), saved ${(cp.bytesSaved / 1e6).toFixed(1)}MB (${cp.eligible} still eligible)`,
      );
    }
  }, cfg.janitorIntervalSeconds * 1000);

  const shutdown = () => {
    clearInterval(tick);
    proc.kill("SIGINT");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
