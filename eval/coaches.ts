import type { GameGraph } from "../kb/schema";
import { reachedSet, deliveredSlice } from "./filter";

export type Coach = (
  graph: GameGraph,
  marker: string[],
  location: string,
) => string | Promise<string>;

/** Audible location readback (§6) — names only the current zone, which is always in-slice. */
function leadIn(graph: GameGraph, location: string): string {
  const z = graph.zones.find((z) => z.id === location);
  return z ? `Looks like you're in ${z.name} — ` : "";
}

/** Pick the best next-hop objective: applies to the current zone, available now, not yet done. */
function pickHop(graph: GameGraph, marker: string[], location: string): string | null {
  const reached = reachedSet(graph, marker);
  const applies = (zoneScoped: boolean) =>
    graph.objectives.find(
      (o) =>
        (!zoneScoped || o.zoneContext === location) &&
        reached.has(o.availableFrom) &&
        !reached.has(o.completedAt) &&
        reached.has(o.reveal.existence),
    );
  return (applies(true) ?? applies(false))?.hopDescription ?? null;
}

/**
 * The reference NAVIGATIONAL coach — a deterministic mini-agent that ONLY speaks the delivered
 * slice: an audible location readback + exactly one reveal-gated next hop (minimal sufficient
 * direction, §6). This is the behavior the build gate expects to pass with zero leaks.
 */
export const safeCoach: Coach = (graph, marker, location) => {
  const hop = pickHop(graph, marker, location);
  if (!hop)
    return "You're a bit past what I've got mapped here — keep exploring and re-trigger when you hit something new.";
  return leadIn(graph, location) + hop;
};

/** A coach that leaks a pretraining-sourced spoiler — proves the eval CATCHES leaks. */
export const leakyCoach: Coach = (graph, marker, location) => {
  const base = safeCoach(graph, marker, location) as string;
  return base + " After that, head up into the City of Tears for the next big upgrade.";
};

/** A safe-but-useless coach — proves the SOFT usefulness gate flags it (without failing the build). */
export const uselessCoach: Coach = () =>
  "Honestly, just explore a bit — you'll figure it out.";

/**
 * Production hook: a real Claude-backed coach. UNTESTED here (needs ANTHROPIC_API_KEY). Shows the
 * integration point — the system prompt is built ONLY from the delivered slice + a no-pretraining
 * instruction, which is what makes the grounding invariant enforceable.
 */
export const claudeCoach: Coach = async (graph, marker, location) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("claudeCoach requires ANTHROPIC_API_KEY");
  const slice = deliveredSlice(graph, marker);
  const here = graph.zones.find((z) => z.id === location)?.name ?? "an unknown area";

  const system = [
    "You are a spoiler-safe game navigation coach. Answer the player's 'where do I go' question.",
    "Reference ONLY entities in the PROVIDED CONTEXT below. NEVER volunteer knowledge of this game",
    "from your own training. If the next step isn't in context, say you're not sure rather than guess.",
    "Lead with an audible location readback, then give exactly ONE next hop. Keep it to 1-2 sentences.",
    "",
    `CURRENT LOCATION: ${here}`,
    "PROVIDED CONTEXT (the only entities you may name):",
    ...slice.entities.map((e) => `- [${e.kind}] ${e.name}`),
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.COACH_MODEL ?? "claude-sonnet-4-6",
      max_tokens: 200,
      system,
      messages: [{ role: "user", content: "I'm lost — where do I go from here?" }],
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${JSON.stringify(data)}`);
  return (data.content ?? []).map((b: any) => b.text ?? "").join("");
};

export const COACHES: Record<string, Coach> = {
  safe: safeCoach,
  leaky: leakyCoach,
  useless: uselessCoach,
  claude: claudeCoach,
};
