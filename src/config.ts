import { homedir } from "node:os";
import { join } from "node:path";

/** Where the capture frames come from. */
export interface CaptureSource {
  /** test = ffmpeg lavfi test pattern (no hardware); device = an avfoundation video device
   *  (your capture card); file = loop a local video file (great for dogfooding the pipeline
   *  on real gameplay footage before hardware arrives). */
  kind: "test" | "device" | "file";
  /** avfoundation device index from `list-devices` (kind === "device"). */
  deviceIndex?: string;
  /** path to a local video file (kind === "file"). */
  filePath?: string;
}

export interface Config {
  dataDir: string;
  segmentDir: string;
  segmentListPath: string;
  watermarksPath: string;
  compactedManifestPath: string;

  /** segment length in seconds (C2 granularity). */
  segmentSeconds: number;
  /** encode params (test/file sources). */
  width: number;
  height: number;
  fps: number;
  bitrate: string;

  // --- retention (see plan §5.1: retain-until-analyzed) ---
  /** always keep at least this much of the most-recent media for live coaching,
   *  regardless of consumer watermarks. */
  liveWindowSeconds: number;
  /** soft disk ceiling (GB). Over this, the janitor warns (force-extraction hook is a TODO). */
  diskCeilingGB: number;
  /** how often the daemon runs the retention janitor. */
  janitorIntervalSeconds: number;

  // --- compaction: compress old media to a low-bitrate analysis proxy (plan §5.1 proxy hook) ---
  compactEnabled: boolean;
  /** segments whose end is older than (liveEdge - this) get compressed to a proxy. */
  compactAgeSeconds: number;
  /** proxy encode params — small enough to slash disk, sharp enough to OCR banners/area titles. */
  proxyWidth: number;
  proxyFps: number;
  proxyBitrate: string;
  /** max segments to compress per janitor tick — bounds CPU while live capture runs. */
  compactBatchPerTick: number;

  source: CaptureSource;
}

export function defaultConfig(overrides: Partial<Config> = {}): Config {
  const dataDir =
    overrides.dataDir ?? join(homedir(), "dev", "game-coach", "data");
  const segmentDir = join(dataDir, "segments");
  return {
    dataDir,
    segmentDir,
    segmentListPath: join(segmentDir, "segments.csv"),
    watermarksPath: join(dataDir, "watermarks.json"),
    compactedManifestPath: join(dataDir, "compacted.json"),
    segmentSeconds: 2,
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: "12M",
    liveWindowSeconds: 900, // 15 min
    diskCeilingGB: 50,
    janitorIntervalSeconds: 10,
    compactEnabled: true,
    compactAgeSeconds: 300, // compress anything older than 5 min
    proxyWidth: 1280,
    proxyFps: 15,
    proxyBitrate: "2.5M",
    compactBatchPerTick: 8,
    source: { kind: "test" },
    ...overrides,
    // keep derived paths consistent if dataDir was overridden
    ...(overrides.dataDir
      ? {
          segmentDir: join(overrides.dataDir, "segments"),
          segmentListPath: join(overrides.dataDir, "segments", "segments.csv"),
          watermarksPath: join(overrides.dataDir, "watermarks.json"),
          compactedManifestPath: join(overrides.dataDir, "compacted.json"),
        }
      : {}),
  };
}
