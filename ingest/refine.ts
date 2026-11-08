import type { GameGraph } from "../kb/schema";
import { validateGraph } from "../kb/schema";
import type { ProvenanceStore } from "./types";
import type { Verdict } from "./llm-sweep";
import type { Decision } from "./verify";

/**
 * Fusion-quality layer (plan §7.2 step 4). Two jobs:
 *  1. ENTITY-VS-DESCRIPTOR: drop nodes that are relative descriptions / hedges, not named entities
 *     ("Unknown Area", "Prior to Metropolis", "Powerful new ability (post-Flora)", "Bosses (general)").
 *  2. CROSS-SOURCE AGREEMENT: score each surviving node by the number of DISTINCT sources that
 *     mention it (from provenance). Multi-source = corroborated; single-source = the contamination
 *     signal (e.g. Silksong entities that bled into HK from one bad source).
 *
 * Keeps the graph valid: dropped zones are repointed to a kept "Unknown Area" fallback; connectors
 * with a dropped endpoint are removed; the lattice is preserved so gates never dangle. Nothing is
 * silent — a quality report records every drop and every single-source flag.
 */

const ARTIFACT_PATTERNS = [
  /\(.*(prior|segment|revisit|post-|border|general).*\)/i,
  /\b(unknown|prior to|first ability|important ability|powerful new ability|new ability)\b/i,
  /^bosses\b/i,
  /^(window|area|zone|room|section)\s*\d+$/i,
];

export function isArtifact(name: string): boolean {
  return ARTIFACT_PATTERNS.some((r) => r.test(name));
}

export interface QualityEntry {
  id: string;
  name: string;
  kind: string;
  sourceCount: number;
  sources: string[];
  classification: "entity" | "artifact" | "contamination";
  corroborated: boolean;
  llm?: Verdict;
  escalated?: boolean;
}

export interface RefineReport {
  total: number;
  keptEntities: number;
  droppedArtifacts: QualityEntry[];
  contamination: QualityEntry[];
  escalated: QualityEntry[];
  singleSource: QualityEntry[];
  corroborated: number;
  quality: QualityEntry[];
}

export interface RefineResult {
  graph: GameGraph;
  report: RefineReport;
}

const FALLBACK = "z_unknown_area";

export function refine(
  graph: GameGraph,
  prov: ProvenanceStore,
  opts: {
    dropSingletons?: boolean;
    sweep?: Map<string, Verdict>;
    sweepThreshold?: number;
    decisions?: Map<string, Decision>;
  } = {},
): RefineResult {
  const sourcesOf = (id: string) =>
    Array.from(new Set((prov[id] ?? []).map((p) => p.sourceId)));
  const thr = opts.sweepThreshold ?? 0.6;
  const quality: QualityEntry[] = [];
  const drop = new Set<string>();

  const classify = (id: string, name: string, kind: string) => {
    const sources = sourcesOf(id);
    const dec = opts.decisions?.get(id);
    const v = opts.sweep?.get(id);
    let classification: QualityEntry["classification"] = isArtifact(name) ? "artifact" : "entity";
    let escalated = false;
    if (dec) {
      // verifier is authoritative — overrides regex/sweep (rescues false positives that ARE grounded)
      if (dec.decision === "drop") classification = "contamination";
      else {
        classification = "entity";
        escalated = dec.decision === "escalate";
      }
    } else if (v && v.confidence >= thr) {
      if (!v.belongsToGame) classification = "contamination";
      else if (!v.isRealEntity) classification = "artifact";
    }
    const q: QualityEntry = {
      id,
      name,
      kind,
      sourceCount: sources.length,
      sources,
      classification,
      corroborated: sources.length >= 2,
      llm: v,
      escalated,
    };
    quality.push(q);
    if (classification !== "entity") drop.add(id);
    if (opts.dropSingletons && classification === "entity" && sources.length <= 1 && !escalated)
      drop.add(id);
    return q;
  };

  for (const z of graph.zones) classify(z.id, z.name, "zone");
  for (const a of graph.abilities) classify(a.id, a.name, a.type);
  for (const b of graph.bosses) classify(b.id, b.name, "boss");
  for (const o of graph.objectives) classify(o.id, o.name, "objective");
  for (const c of graph.connectors) classify(c.id, c.description, "connector");

  // keep a fallback zone so references to dropped zones stay valid
  let zones = graph.zones.filter((z) => !drop.has(z.id));
  if (!zones.find((z) => z.id === FALLBACK))
    zones.push({
      id: FALLBACK,
      type: "zone",
      name: "Unknown Area",
      reveal: { existence: graph.lattice[0]?.id ?? "m_start" },
      qaStatus: "unverified",
      note: "refine fallback for repointed references",
    });
  const keptZone = new Set(zones.map((z) => z.id));
  const repoint = (zid: string) => (keptZone.has(zid) ? zid : FALLBACK);

  const abilities = graph.abilities
    .filter((a) => !drop.has(a.id))
    .map((a) => ({ ...a, acquiredAtZone: repoint(a.acquiredAtZone) }));
  const bosses = graph.bosses
    .filter((b) => !drop.has(b.id))
    .map((b) => ({ ...b, zone: repoint(b.zone) }));
  const objectives = graph.objectives
    .filter((o) => !drop.has(o.id))
    .map((o) => ({ ...o, zoneContext: repoint(o.zoneContext) }));
  const connectors = graph.connectors.filter(
    (c) => !drop.has(c.id) && keptZone.has(c.fromZone) && keptZone.has(c.toZone),
  );

  const refined: GameGraph = { ...graph, zones, abilities, bosses, objectives, connectors };
  const errs = validateGraph(refined).filter((i) => i.severity === "error");
  if (errs.length)
    throw new Error("refine produced an invalid graph: " + JSON.stringify(errs.slice(0, 3)));

  const report: RefineReport = {
    total: quality.length,
    keptEntities: quality.filter((q) => !drop.has(q.id)).length,
    droppedArtifacts: quality.filter((q) => q.classification === "artifact"),
    contamination: quality.filter((q) => q.classification === "contamination"),
    escalated: quality.filter((q) => q.escalated),
    singleSource: quality.filter((q) => q.classification === "entity" && q.sourceCount <= 1),
    corroborated: quality.filter((q) => q.corroborated).length,
    quality,
  };
  return { graph: refined, report };
}
