import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { getFrame } from "../src/frames";
import { readSegments, captureSpan } from "../src/timeline";
import { ask, type AskResult } from "../rag/ask";
import { loadDotEnv } from "../ingest/env";

/** What the vision pass reads off the current screen. Kept navigational for P1a. */
export interface Scene {
  isGameplay: boolean;
  locationGuess: string;
  onScreen: string;
  visibleExits: string;
  confidence: number;
}

const SCENE_TOOL = {
  name: "report_scene",
  description: "Report what is visible on the current game screen, for navigational coaching.",
  input_schema: {
    type: "object",
    properties: {
      isGameplay: { type: "boolean", description: "true if in the game world; false if a menu, map, loading or title screen." },
      locationGuess: { type: "string", description: "Best guess of the current zone/area/room name in this game, else 'unknown'." },
      onScreen: { type: "string", description: "Concrete visible elements: terrain, doors/exits, enemies, NPCs, benches, gates, items, HUD." },
      visibleExits: { type: "string", description: "Where the player could move from here: left/right/up/down, doors, drops, gates." },
      confidence: { type: "number", description: "0-1 confidence in locationGuess." },
    },
    required: ["isGameplay", "locationGuess", "onScreen", "visibleExits", "confidence"],
  },
} as const;

async function identifyScene(apiKey: string, game: string, b64: string): Promise<Scene> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.COACH_VISION_MODEL ?? "claude-sonnet-4-6",
      max_tokens: 500,
      tool_choice: { type: "tool", name: "report_scene" },
      tools: [SCENE_TOOL],
      system:
        `You are the vision module of a live coach for the game "${game}". Read ONLY what is actually on ` +
        `this frame — do not infer story or future areas. Describe the player's current location and immediate surroundings.`,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
            { type: "text", text: "Identify the current screen for navigational help." },
          ],
        },
      ],
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`anthropic vision ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  const tu = (data.content ?? []).find((b: any) => b.type === "tool_use");
  return tu?.input as Scene;
}

export interface ReviewResult {
  t: number;
  framePath: string;
  scene: Scene;
  rag: AskResult;
}

/**
 * One coaching turn: latest live frame → vision (where am I) → spoiler-conservative RAG (where to go).
 * NAVIGATIONAL-only for P1a: the answer prompt forbids revealing content beyond the immediate next step.
 */
export async function review(
  game: string,
  question: string | undefined,
  opts: { dataDir?: string } = {},
): Promise<ReviewResult> {
  loadDotEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("coach review needs ANTHROPIC_API_KEY");

  const cfg = defaultConfig(opts.dataDir ? { dataDir: opts.dataDir } : {});
  const span = captureSpan(await readSegments(cfg.segmentListPath));
  if (!span) throw new Error("no capture buffer — is the daemon running? (npm run start -- --source=device:N)");

  // sample ~1.5s behind the live edge: that segment is finalized and safely inside the buffer
  const t = Math.max(span.start, span.end - 1.5);
  const framePath = join(cfg.dataDir, "_coach_frame.jpg");
  const fr = await getFrame(cfg, t, { width: 1024, out: framePath });
  if (!fr.ok) throw new Error(`frame grab failed: ${fr.reason}`);
  const b64 = (await readFile(framePath)).toString("base64");

  const scene = await identifyScene(apiKey, game, b64);

  const q = question?.trim() || "Where am I and where should I go next from here?";
  const ragQuery =
    `${q}\n(Current screen — location: ${scene.locationGuess}; visible: ${scene.onScreen}; exits: ${scene.visibleExits})`;

  const rag = await ask(game, ragQuery, {
    system:
      `You are a live navigational coach for "${game}". The player is mid-game and asked for help. ` +
      `Using ONLY the provided context passages, tell them concisely WHERE THEY ARE and the immediate NEXT move ` +
      `(which direction/exit to take, what to do right here). Speak directly to the player ("You're in…", "Head left…"). ` +
      `Give only the next step or two — do NOT reveal future bosses, items, or story beyond what's immediately needed. ` +
      `If the passages don't cover this spot, say so and suggest trying a visible exit. Cite passages like [2].`,
  });

  return { t, framePath, scene, rag };
}
