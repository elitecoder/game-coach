import { readFile } from "node:fs/promises";
import type { Segment, Fragment } from "./types";
import { loadDotEnv } from "./env";

const MODEL = process.env.COACH_EXTRACT_MODEL ?? "claude-sonnet-4-6";

/** JSON schema for the forced extraction tool — guarantees a parseable, schema-shaped Fragment. */
const FRAGMENT_TOOL = {
  name: "emit_graph_fragment",
  description:
    "Emit the game-knowledge graph fragment extracted from this walkthrough segment.",
  input_schema: {
    type: "object",
    properties: {
      segmentProgressionRank: {
        type: "number",
        description: "How far into the game this segment sits: 0=very start, 1=endgame.",
      },
      milestones: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            kind: {
              type: "string",
              enum: ["boss_defeat", "ability", "zone_entry", "item", "event"],
            },
            note: { type: "string" },
          },
          required: ["name", "kind"],
        },
      },
      zones: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            fingerprintHint: { type: "string" },
            note: { type: "string" },
          },
          required: ["name"],
        },
      },
      abilities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["ability", "key_item"] },
            acquiredAtZone: { type: "string" },
            grants: { type: "string" },
            note: { type: "string" },
          },
          required: ["name", "type"],
        },
      },
      bosses: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            zone: { type: "string" },
            note: { type: "string" },
          },
          required: ["name"],
        },
      },
      objectives: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            zoneContext: { type: "string" },
            hopDescription: { type: "string" },
            leadsToMilestone: { type: "string" },
            note: { type: "string" },
          },
          required: ["name", "hopDescription"],
        },
      },
      connectors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fromZone: { type: "string" },
            toZone: { type: "string" },
            bidirectional: { type: "boolean" },
            requiresAbilityOrItem: { type: "string" },
            description: { type: "string" },
            note: { type: "string" },
          },
          required: ["fromZone", "toZone", "description"],
        },
      },
    },
    required: ["segmentProgressionRank", "milestones", "zones", "abilities", "bosses", "objectives", "connectors"],
  },
} as const;

async function imageBlock(path: string) {
  const data = (await readFile(path)).toString("base64");
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
}

/**
 * VLM extraction (§7.2 step 3): Claude vision over [keyframes + transcript] -> a schema-shaped
 * fragment. Game-agnostic: the game name is just context. The SAME vision machinery the play-time
 * coach uses, pointed at expert footage. Requires ANTHROPIC_API_KEY.
 */
export async function extractSegment(
  game: string,
  seg: Segment,
  topic?: string,
): Promise<Fragment> {
  loadDotEnv();
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("extractSegment requires ANTHROPIC_API_KEY (set it, or put it in game-coach/.env)");

  const images = await Promise.all(seg.keyframePaths.map(imageBlock));
  const evidenceNote = images.length
    ? `Use the keyframes as the primary evidence (the transcript is secondary and often vague). Name zones/bosses/abilities exactly as the game shows them.`
    : `This is a TEXT source (no images) — a walkthrough/wiki page, the primary structural evidence. Name zones/bosses/abilities/connectors exactly as written; capture connectivity and order where stated.`;
  const text =
    `Game: ${game}\n` +
    (topic ? `Source topic: ${topic}\n` : "") +
    `Segment title: ${seg.title}\n` +
    `${images.length ? "Segment transcript" : "Text"}:\n${seg.transcript || "(none)"}\n\n` +
    `Extract the game-knowledge graph fragment for THIS segment only. ${evidenceNote} ` +
    `Estimate segmentProgressionRank (0=game start, 1=endgame). Only include what this segment actually shows or states.`;

  const body = {
    model: MODEL,
    max_tokens: 1500,
    tools: [FRAGMENT_TOOL],
    tool_choice: { type: "tool", name: "emit_graph_fragment" },
    messages: [{ role: "user", content: [...images, { type: "text", text }] }],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${JSON.stringify(data)}`);

  const toolUse = (data.content ?? []).find((b: any) => b.type === "tool_use");
  if (!toolUse) throw new Error(`no tool_use in response: ${JSON.stringify(data)}`);
  return toolUse.input as Fragment;
}
