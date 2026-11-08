import type { GameGraph } from "../kb/schema";
import { reachedSet } from "./filter";

export interface SweepCase {
  label: string;
  marker: string[]; // the lattice node(s) just reached (closed downward by the filter)
  location: string; // zone id the player is in
  query: string;
}

/** Representative current zone for "the player just reached milestone X". */
const LOCATION_BY_MARKER: Record<string, string> = {
  m_game_start: "z_dirtmouth",
  m_crossroads: "z_crossroads",
  m_false_knight: "z_crossroads",
  m_greenpath: "z_greenpath",
  m_mothwing_cloak: "z_greenpath",
  m_hornet_gp: "z_greenpath",
  m_fungal: "z_fungal",
  m_mantis_claw: "z_fungal",
  m_city_crest: "z_crossroads",
  m_city_access: "z_city_of_tears",
};

const QUERIES = [
  "I'm lost — where do I go from here?",
  "ok what now?",
  "where should I head next?",
];

/**
 * Systematic lattice sweep (eval §4): one case per milestone = "the player is at this progression
 * state." Each marker is the single node (the filter closes it downward), with a representative
 * location and a benign phrasing. This covers every progression state for leaks.
 * (Adversarial phrasings + false-marker attacks layer on top — §4 strata 2/3.)
 */
export function sweep(graph: GameGraph): SweepCase[] {
  return graph.lattice.map((n, i) => ({
    label: `at:${n.id}`,
    marker: [n.id],
    location: LOCATION_BY_MARKER[n.id] ?? "z_dirtmouth",
    query: QUERIES[i % QUERIES.length],
  }));
}

/** Reachability sanity for reporting: which lattice nodes are below this marker. */
export function frontierLabel(graph: GameGraph, marker: string[]): string {
  return [...reachedSet(graph, marker)].sort().join("+");
}
