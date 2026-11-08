import type { GameGraph, LatticeNode } from "../kb/schema";
import type {
  Fragment,
  Segment,
  ProvenanceStore,
  ProvenanceEntry,
  Conflict,
} from "./types";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "") // merge "The Collector" == "Collector", "The Radiance" == "Radiance"
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "") || "x";

interface FragInput {
  fragment: Fragment;
  segment: Segment;
}

export interface FuseResult {
  graph: GameGraph;
  provenance: ProvenanceStore;
  conflicts: Conflict[];
}

/**
 * Cross-source fusion (§7.2 step 4 + §7.4): merge per-segment fragments into one schema-conformant
 * GameGraph. Dedupe entities by normalized name, resolve name references to ids (creating stub
 * zones so the graph validates), synthesize a provisional linear progression lattice from segment
 * ranks, and wire reveal-gates against it. EVERYTHING is qaStatus="unverified" — machine-extracted
 * graphs are candidates the reveal-gate eval + human QA harden, never authority (eval §0).
 */
export function fuse(game: string, rawInputs: FragInput[]): FuseResult {
  // defensive: models occasionally omit a "required" array; default them so fusion never throws.
  const inputs: FragInput[] = rawInputs.map(({ fragment, segment }) => ({
    segment,
    fragment: {
      milestones: fragment.milestones ?? [],
      zones: fragment.zones ?? [],
      abilities: fragment.abilities ?? [],
      bosses: fragment.bosses ?? [],
      objectives: fragment.objectives ?? [],
      connectors: fragment.connectors ?? [],
      segmentProgressionRank: fragment.segmentProgressionRank ?? 0,
    },
  }));
  const provenance: ProvenanceStore = {};
  const conflicts: Conflict[] = [];
  const prov = (id: string, seg: Segment) => {
    const e: ProvenanceEntry = {
      sourceId: seg.sourceId,
      videoId: seg.videoId,
      segmentIndex: seg.index,
      segmentTitle: seg.title,
      startSec: seg.startSec,
      endSec: seg.endSec,
    };
    (provenance[id] ??= []).push(e);
  };

  // ---- 1. milestones -> provisional linear lattice ordered by progression rank ----
  const mRank = new Map<string, { sum: number; n: number; name: string }>();
  for (const { fragment } of inputs)
    for (const m of fragment.milestones) {
      const id = `m_${slug(m.name)}`;
      const cur = mRank.get(id) ?? { sum: 0, n: 0, name: m.name };
      cur.sum += fragment.segmentProgressionRank;
      cur.n += 1;
      mRank.set(id, cur);
    }
  const ordered = [...mRank.entries()]
    .map(([id, v]) => ({ id, rank: v.sum / v.n, name: v.name }))
    .sort((a, b) => a.rank - b.rank);
  if (ordered.length === 0)
    ordered.push({ id: "m_start", rank: 0, name: "Start" });

  const lattice: LatticeNode[] = ordered.map((m, i) => ({
    id: m.id,
    name: m.name,
    requires: i === 0 ? [] : [ordered[i - 1].id],
    detectableBy: ["zone_fingerprint"],
    signalStrength: "advisory",
    qaStatus: "unverified",
    note: "machine-inferred milestone; linear order is a walkthrough approximation",
  }));
  const gateForRank = (r: number): string => {
    let g = ordered[0].id;
    for (const m of ordered) if (m.rank <= r + 1e-9) g = m.id;
    return g;
  };
  const milestoneByName = new Map(ordered.map((m) => [slug(m.name), m.id]));

  // ---- 2. zones (get-or-create so all references resolve) ----
  const zoneId = new Map<string, string>(); // slug -> id
  const zones: GameGraph["zones"] = [];
  const ensureZone = (name: string | undefined, seg?: Segment, rank = 0) => {
    if (!name) return undefined;
    const s = slug(name);
    let id = zoneId.get(s);
    if (!id) {
      id = `z_${s}`;
      zoneId.set(s, id);
      zones.push({
        id,
        type: "zone",
        name,
        reveal: { existence: gateForRank(rank) },
        qaStatus: "unverified",
      });
    }
    if (seg) prov(id, seg);
    return id;
  };
  for (const { fragment, segment } of inputs)
    for (const z of fragment.zones) {
      const id = ensureZone(z.name, segment, fragment.segmentProgressionRank)!;
      const node = zones.find((n) => n.id === id)!;
      if (z.fingerprintHint && !node.fingerprintHint)
        node.fingerprintHint = z.fingerprintHint;
    }

  // ---- 3. abilities / bosses / objectives / connectors ----
  const abilities: GameGraph["abilities"] = [];
  const seenAbility = new Set<string>();
  for (const { fragment, segment } of inputs)
    for (const a of fragment.abilities) {
      const id = `a_${slug(a.name)}`;
      prov(id, segment);
      if (seenAbility.has(id)) continue;
      seenAbility.add(id);
      abilities.push({
        id,
        type: a.type,
        name: a.name,
        acquiredAtZone:
          ensureZone(a.acquiredAtZone, segment, fragment.segmentProgressionRank) ??
          ensureZone("Unknown Area")!,
        marker: milestoneByName.get(slug(a.name)) ?? gateForRank(fragment.segmentProgressionRank),
        reveal: { existence: gateForRank(fragment.segmentProgressionRank) },
        qaStatus: "unverified",
        note: a.note,
      });
    }

  const bosses: GameGraph["bosses"] = [];
  const seenBoss = new Set<string>();
  for (const { fragment, segment } of inputs)
    for (const b of fragment.bosses) {
      const id = `b_${slug(b.name)}`;
      prov(id, segment);
      if (seenBoss.has(id)) continue;
      seenBoss.add(id);
      bosses.push({
        id,
        type: "boss",
        name: b.name,
        zone: ensureZone(b.zone, segment, fragment.segmentProgressionRank) ?? ensureZone("Unknown Area")!,
        marker: milestoneByName.get(slug(b.name)) ?? gateForRank(fragment.segmentProgressionRank),
        reveal: { existence: gateForRank(fragment.segmentProgressionRank) },
        qaStatus: "unverified",
        note: b.note,
      });
    }

  const objectives: GameGraph["objectives"] = [];
  const seenObj = new Set<string>();
  for (const { fragment, segment } of inputs)
    for (const o of fragment.objectives) {
      const id = `o_${slug(o.name)}`;
      prov(id, segment);
      if (seenObj.has(id)) continue;
      seenObj.add(id);
      const availableFrom = gateForRank(fragment.segmentProgressionRank);
      const completedAt =
        (o.leadsToMilestone && milestoneByName.get(slug(o.leadsToMilestone))) ||
        nextMilestone(ordered, availableFrom);
      objectives.push({
        id,
        type: "objective",
        name: o.name,
        zoneContext:
          ensureZone(o.zoneContext, segment, fragment.segmentProgressionRank) ?? ensureZone("Unknown Area")!,
        availableFrom,
        completedAt,
        hopDescription: o.hopDescription,
        reveal: { existence: availableFrom },
        qaStatus: "unverified",
        note: o.note,
      });
    }

  const connectors: GameGraph["connectors"] = [];
  const seenConn = new Set<string>();
  for (const { fragment, segment } of inputs)
    for (const c of fragment.connectors) {
      const from = ensureZone(c.fromZone, segment, fragment.segmentProgressionRank)!;
      const to = ensureZone(c.toZone, segment, fragment.segmentProgressionRank)!;
      const id = `c_${slug(c.fromZone)}__${slug(c.toZone)}`;
      prov(id, segment);
      if (seenConn.has(id)) continue;
      seenConn.add(id);
      const reqAbilitySlug = c.requiresAbilityOrItem ? slug(c.requiresAbilityOrItem) : undefined;
      const traversalGate =
        (reqAbilitySlug && milestoneByName.get(reqAbilitySlug)) ||
        gateForRank(fragment.segmentProgressionRank);
      connectors.push({
        id,
        type: "connector",
        fromZone: from,
        toZone: to,
        bidirectional: c.bidirectional,
        traversalGate,
        description: c.description,
        qaStatus: "unverified",
        note: c.note,
      });
    }

  const graph: GameGraph = {
    game,
    scope: "machine-ingested from video (provisional, all nodes unverified)",
    lattice,
    zones,
    abilities,
    bosses,
    objectives,
    connectors,
  };
  return { graph, provenance, conflicts };
}

function nextMilestone(
  ordered: { id: string; rank: number }[],
  afterId: string,
): string {
  const i = ordered.findIndex((m) => m.id === afterId);
  return ordered[Math.min(i + 1, ordered.length - 1)].id;
}
