import type { GameGraph } from "../kb/schema";
import { allEntities } from "./filter";

/**
 * Grounding check — the PRIMARY invariant (eval §1). Every game-world entity the answer names must
 * be in the delivered slice. Anything named that isn't delivered is a leak (the model volunteering
 * it from pretraining knowledge of the game).
 *
 * NOTE: this is the DETERMINISTIC demo version — substring match against the graph vocab + aliases.
 * Production swaps in an LLM open-vocab NER pass so it also catches a place name that ISN'T in our
 * vocab (the truly dangerous leak); that's the §10 open item. The mechanism below is identical;
 * only the entity extractor changes.
 */

export interface VocabEntry {
  id: string;
  name: string;
  aliases: string[];
}

/** Hand aliases for surface forms the coach might use that differ from the canonical name. */
const ALIASES: Record<string, string[]> = {
  z_crossroads: ["crossroads"],
  z_greenpath: ["greenpath"],
  z_fungal: ["fungal wastes", "fungal"],
  z_city_of_tears: ["city of tears", "the city"],
  a_mothwing_cloak: ["mothwing", "mothwing cloak"],
  a_mantis_claw: ["mantis claw"],
  i_city_crest: ["city crest"],
  b_false_knight: ["false knight"],
  b_hornet_gp: ["hornet"],
};

export function buildVocab(graph: GameGraph): VocabEntry[] {
  // connectors are described, not named — exclude from NER (their description is prose, not a proper noun)
  return allEntities(graph)
    .filter((e) => e.kind !== "connector")
    .map((e) => ({ id: e.id, name: e.name, aliases: ALIASES[e.id] ?? [] }));
}

export interface NamedHit {
  entityId: string;
  matched: string;
}

export function findNamedEntities(answer: string, vocab: VocabEntry[]): NamedHit[] {
  const lower = answer.toLowerCase();
  const hits: NamedHit[] = [];
  for (const e of vocab) {
    for (const form of [e.name, ...e.aliases]) {
      if (form.length < 4) continue;
      if (lower.includes(form.toLowerCase())) {
        hits.push({ entityId: e.id, matched: form });
        break;
      }
    }
  }
  return hits;
}

export interface GroundingResult {
  leaks: NamedHit[];
  groundedIds: string[];
}

export function checkGrounding(
  answer: string,
  deliveredIds: Set<string>,
  vocab: VocabEntry[],
): GroundingResult {
  const hits = findNamedEntities(answer, vocab);
  return {
    leaks: hits.filter((h) => !deliveredIds.has(h.entityId)),
    groundedIds: hits.filter((h) => deliveredIds.has(h.entityId)).map((h) => h.entityId),
  };
}

/**
 * Usefulness check (soft gate, eval §2.6). Heuristic for the demo: a concrete answer gives a
 * direction and isn't a punt. Production uses an LLM usefulness judge. A good nav answer can be
 * useful WITHOUT naming the destination zone (it phrases the hop relative to revealed landmarks to
 * stay spoiler-safe), so "names a zone" is deliberately NOT the test.
 */
const DIRECTION_CUES = [
  "head", "go ", "take ", "down", "up ", "west", "east", "north", "south",
  "exit", "toward", "back to", "deeper", "into", "climb",
];
const PUNTS = ["just explore", "figure it out", "wander", "not sure where", "you'll figure"];

export function checkUsefulness(answer: string): boolean {
  const a = answer.toLowerCase();
  const hasDirection = DIRECTION_CUES.some((d) => a.includes(d));
  const isPunt = PUNTS.some((p) => a.includes(p));
  return hasDirection && !isPunt;
}
