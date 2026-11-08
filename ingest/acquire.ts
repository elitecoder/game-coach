import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Source, Acquired, Chapter } from "./types";

const execFileP = promisify(execFile);

/**
 * Acquire one VIDEO source via yt-dlp: a size/duration-capped video + English subs + chapters +
 * info JSON. The duration cap keeps us on short targeted guides (boss/ability clips), not multi-hour
 * playthroughs — the structural backbone comes from text sources, video adds visual grounding.
 */
export async function acquire(
  source: Source,
  rawDir: string,
  durationCapSec = 1200,
): Promise<Acquired> {
  const dir = join(rawDir, source.id);
  await mkdir(dir, { recursive: true });
  let input = source.url ?? source.query;
  if (!input) throw new Error(`source ${source.id} has neither url nor query`);
  // widen searches so the duration filter has candidates to choose among
  input = input.replace(/^ytsearch\d*:/, "ytsearch15:");

  const args = [
    "-f",
    "best[height<=480]/best",
    "--match-filter",
    `duration < ${durationCapSec}`,
    "--max-downloads",
    "1",
    "--write-info-json",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "en.*",
    "--convert-subs",
    "srt",
    "--no-progress",
    "-o",
    join(dir, "%(id)s.%(ext)s"),
    input,
  ];

  try {
    await execFileP("yt-dlp", args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (e: any) {
    // yt-dlp exits non-zero on --max-downloads reached (101) and on filter skips. Tolerate if a
    // video info.json was actually produced; otherwise surface a clear "nothing acceptable" error.
    const got = (await readdir(dir).catch(() => [])).some((f) => f.endsWith(".info.json"));
    if (!got)
      throw new Error(
        `yt-dlp produced nothing for ${source.id} under ${durationCapSec}s: ${String(e.message).slice(0, 160)}`,
      );
  }

  const files = await readdir(dir);
  // pick the entry info.json (not the search-playlist meta)
  let info: any;
  for (const f of files.filter((f) => f.endsWith(".info.json"))) {
    const j = JSON.parse(await readFile(join(dir, f), "utf8"));
    if (j._type === "playlist") continue;
    if (j.id) {
      info = j;
      break;
    }
  }
  if (!info) throw new Error(`no usable video info.json in ${dir}`);

  const videoName = files.find(
    (f) =>
      !f.endsWith(".info.json") &&
      !f.endsWith(".srt") &&
      !f.endsWith(".vtt") &&
      !f.endsWith(".part") &&
      !f.endsWith(".ytdl"),
  );
  if (!videoName) throw new Error(`no video file in ${dir}`);
  const subName = files.find((f) => f.endsWith(".srt"));

  const chapters: Chapter[] = Array.isArray(info.chapters)
    ? info.chapters.map((c: any) => ({
        startSec: c.start_time ?? 0,
        endSec: c.end_time ?? 0,
        title: c.title ?? "untitled",
      }))
    : [];

  return {
    sourceId: source.id,
    videoId: info.id ?? videoName,
    title: info.title ?? source.id,
    durationSec: info.duration ?? 0,
    webpageUrl: info.webpage_url ?? input,
    videoPath: join(dir, videoName),
    subtitlePath: subName ? join(dir, subName) : undefined,
    chapters,
  };
}
