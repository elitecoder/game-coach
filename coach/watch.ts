import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { getFrame } from "../src/frames";
import { readSegments, captureSpan } from "../src/timeline";
import { loadDotEnv } from "../ingest/env";
import { startHud, setHud, setFramePath } from "./hud";
import { GOALS, type Goal } from "./goal";

type HudStatus = "on_track" | "searching" | "off_track" | "arrived";

const execFileP = promisify(execFile);
// frame-change detection: mean abs pixel diff over a 32x18 gray thumbnail.
// below CHANGE_THRESH = essentially the same screen (only ambient particle drift) → hold last judgment.
const CHANGE_THRESH = 9;
const FORCE_REEVAL_MS = 20000; // failsafe: re-evaluate at least this often even if static

/** Tiny grayscale signature of a frame for cheap "did the screen change?" diffing. */
async function signature(jpegPath: string): Promise<Buffer> {
  const { stdout } = await execFileP(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-i", jpegPath, "-vf", "scale=32x18,format=gray", "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 1 << 20 },
  );
  return stdout as Buffer;
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  if (!n) return Infinity;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n;
}

/** Coarse localization only: which waypoint is on screen. We do NOT ask vision to pinpoint
 *  ledges/targets — it can't do that reliably. Direction + hazard come from the route. */
async function matchWaypoint(apiKey: string, game: string, goal: Goal, b64: string): Promise<{ idx: number; confidence: number }> {
  const options = goal.waypoints.map((w, i) => `${i}: ${w.label} — ${w.look}`).join("\n");
  const TOOL = {
    name: "report",
    description: "Report which waypoint the current screen matches.",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "integer", description: "Index of the best-matching waypoint, or -1 if none match." },
        confidence: { type: "number", description: "0-1 confidence." },
      },
      required: ["index", "confidence"],
    },
  } as const;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.COACH_VISION_MODEL ?? "claude-sonnet-4-6",
      max_tokens: 150,
      tool_choice: { type: "tool", name: "report" },
      tools: [TOOL],
      system:
        `You localize a "${game}" player against a list of waypoints by matching the VISIBLE scene. ` +
        `Judge only by what's on screen; if it clearly matches none, return -1.\n\nWaypoints:\n${options}`,
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }, { type: "text", text: "Which waypoint is this?" }] },
      ],
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`vision ${res.status}: ${JSON.stringify(data).slice(0, 160)}`);
  const tu = (data.content ?? []).find((b: any) => b.type === "tool_use");
  return { idx: tu?.input?.index ?? -1, confidence: tu?.input?.confidence ?? 0 };
}

export async function runWatch(game: string, goalId: string, opts: { dataDir?: string; port?: number; tickMs?: number } = {}) {
  loadDotEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("watch needs ANTHROPIC_API_KEY");
  const goal = GOALS[goalId];
  if (!goal) throw new Error(`unknown goal '${goalId}' (have: ${Object.keys(GOALS).join(", ")})`);

  const cfg = defaultConfig(opts.dataDir ? { dataDir: opts.dataDir } : {});
  const port = opts.port ?? 4319;
  const framePath = join(cfg.dataDir, "_hud_frame.jpg");
  setFramePath(framePath);
  await startHud(port);
  const total = goal.waypoints.length;
  const wp0 = goal.waypoints[0];
  setHud({ leg: wp0.label, direction: wp0.direction, hazard: hazardOf(wp0), total, step: 1, status: "searching" });
  console.log(`\n  Coach overlay: http://localhost:${port}   (goal: ${goal.title})\n  directions only — re-evaluates only when the screen changes — Ctrl-C to stop\n`);

  let reached = 0;
  let backtrack = 0; // consecutive evals suggesting a backtrack — guards against one-off cave mismatches
  let prevSig: Buffer | null = null;
  let lastEvalAt = 0;
  const tick = async () => {
    try {
      const span = captureSpan(await readSegments(cfg.segmentListPath));
      if (!span) return;
      const t = Math.max(span.start, span.end - 0.7);
      const fr = await getFrame(cfg, t, { width: 960, out: framePath });
      if (!fr.ok) return;

      // cheap local change-detection FIRST — no vision call unless the screen actually changed
      const sig = await signature(framePath);
      const diff = prevSig ? meanAbsDiff(sig, prevSig) : Infinity;
      prevSig = sig;
      const now = Date.now();
      const changed = diff >= CHANGE_THRESH || now - lastEvalAt >= FORCE_REEVAL_MS;
      if (!changed) {
        setHud({}); // bump ts so the mirror stays live, but HOLD the instruction unchanged
        console.log(`  [${new Date().toISOString().slice(11, 19)}] · held (Δ=${diff.toFixed(1)}) — no vision call`);
        return;
      }
      lastEvalAt = now;

      const b64 = (await readFile(framePath)).toString("base64");
      const { idx, confidence } = await matchWaypoint(apiKey, game, goal, b64);

      // a single backtrack-looking match is usually a cave-vs-cave vision mixup, not a real wrong turn.
      const looksBacktrack = idx >= 0 && reached - idx >= 2 && confidence >= 0.55;
      backtrack = looksBacktrack ? backtrack + 1 : 0;

      let status: HudStatus;
      if (idx >= 0 && goal.waypoints[idx].direction === "done") status = "arrived";
      else if (backtrack >= 2) status = "off_track"; // only after sustained evidence
      else if (idx < 0 || confidence < 0.4) status = "searching";
      else status = "on_track";
      if (idx >= 0 && !looksBacktrack) reached = Math.max(reached, idx);

      // direction + hazard are ROUTE knowledge from the current leg, not a vision guess
      const cur = goal.waypoints[reached];
      setHud({ status, direction: cur.direction, hazard: hazardOf(cur), step: reached + 1, total, leg: cur.label });
      console.log(`  [${new Date().toISOString().slice(11, 19)}] ${status.padEnd(9)} go ${cur.direction}  (${(confidence * 100) | 0}% @ ${cur.label})`);
    } catch (e: any) {
      console.error("  tick error:", e.message);
    }
  };
  await tick();
  setInterval(tick, opts.tickMs ?? 2000);
}

/** First clause of the authored hazard — short enough for a glance. */
function hazardOf(wp: Goal["waypoints"][number]): string | undefined {
  return wp.hazard?.split(/[—.]/)[0]?.trim() || undefined;
}
