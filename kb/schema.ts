/**
 * T0 game-graph schema (plan §7.1) — the structural KB the NAVIGATIONAL coach traverses and the
 * reveal-gate red-team eval checks against (see spoiler-redteam-eval.md).
 *
 * Two ideas do all the work:
 *  1. A progression-marker LATTICE — a partial order of detectable milestones. The player's marker
 *     (C6) is a downward-closed set of these. "frontier" = the maximal reached nodes.
 *  2. Every entity carries REVEAL GATES referencing lattice nodes: you may name an entity only when
 *     the frontier has reached its existence gate; you may assert a connector is passable only when
 *     the frontier has reached its traversal gate (§7.3 — the relational leak).
 */

export type Detector = "menu" | "zone_fingerprint" | "event";
export type SignalStrength = "strong" | "advisory";
export type QaStatus = "verified" | "unverified";

/** A milestone in the progression lattice. `requires` defines the partial order. */
export interface LatticeNode {
  id: string;
  name: string;
  requires: string[]; // prerequisite lattice node ids
  detectableBy: Detector[];
  /** menu/ability reads are ground truth (strong); passively-detected boss kills are advisory (§6). */
  signalStrength: SignalStrength;
  qaStatus: QaStatus;
  note?: string;
}

/** Reveal gates (§7.3): existence vs (optional) detail. */
export interface RevealGate {
  existence: string; // lattice node id; name the entity only when frontier >= this
  detail?: string; // optional higher gate for spoilery detail
}

export interface ZoneNode {
  id: string;
  type: "zone";
  name: string;
  fingerprintHint?: string;
  reveal: RevealGate;
  qaStatus: QaStatus;
  note?: string;
}

export interface AbilityNode {
  id: string;
  type: "ability" | "key_item";
  name: string;
  acquiredAtZone: string; // zone id
  marker: string; // lattice node id this acquisition corresponds to
  reveal: RevealGate;
  qaStatus: QaStatus;
  note?: string;
}

export interface BossNode {
  id: string;
  type: "boss";
  name: string;
  zone: string;
  marker?: string; // lattice node for its defeat
  reveal: RevealGate;
  qaStatus: QaStatus;
  note?: string;
}

/** A spoken next-hop candidate. The coach returns at most one (minimal sufficient direction, §6). */
export interface ObjectiveNode {
  id: string;
  type: "objective";
  name: string;
  zoneContext: string; // zone id the player is in for this to apply
  /** available as a next-hop while frontier >= availableFrom and < completedAt. */
  availableFrom: string; // lattice node id
  completedAt: string; // lattice node id
  hopDescription: string; // the spoken hop, phrased relative to revealed landmarks only
  reveal: RevealGate;
  qaStatus: QaStatus;
  note?: string;
}

export interface Connector {
  id: string;
  type: "connector";
  fromZone: string;
  toZone: string;
  bidirectional: boolean;
  traversalGate: string; // lattice node at/below which you may assert it's passable
  description: string;
  qaStatus: QaStatus;
  note?: string;
}

export interface GameGraph {
  game: string;
  scope: string;
  lattice: LatticeNode[];
  zones: ZoneNode[];
  abilities: AbilityNode[];
  bosses: BossNode[];
  objectives: ObjectiveNode[];
  connectors: Connector[];
}

// --- validation (§7.4 graph-validation: the structural checks that fail the build) ---

export interface Issue {
  severity: "error" | "warn";
  where: string;
  message: string;
}

export function validateGraph(g: GameGraph): Issue[] {
  const issues: Issue[] = [];
  const latticeIds = new Set(g.lattice.map((n) => n.id));
  const zoneIds = new Set(g.zones.map((z) => z.id));

  const refLattice = (id: string | undefined, where: string) => {
    if (id == null) return;
    if (!latticeIds.has(id))
      issues.push({ severity: "error", where, message: `unknown lattice node '${id}'` });
  };
  const refZone = (id: string, where: string) => {
    if (!zoneIds.has(id))
      issues.push({ severity: "error", where, message: `unknown zone '${id}'` });
  };

  // lattice references + acyclicity (partial order must be a DAG)
  for (const n of g.lattice)
    for (const r of n.requires) refLattice(r, `lattice/${n.id}.requires`);
  detectCycle(g.lattice, issues);

  // entity gate references
  for (const z of g.zones) {
    refLattice(z.reveal.existence, `zone/${z.id}.reveal.existence`);
    refLattice(z.reveal.detail, `zone/${z.id}.reveal.detail`);
  }
  for (const a of g.abilities) {
    refZone(a.acquiredAtZone, `ability/${a.id}.acquiredAtZone`);
    refLattice(a.marker, `ability/${a.id}.marker`);
    refLattice(a.reveal.existence, `ability/${a.id}.reveal.existence`);
  }
  for (const b of g.bosses) {
    refZone(b.zone, `boss/${b.id}.zone`);
    refLattice(b.marker, `boss/${b.id}.marker`);
    refLattice(b.reveal.existence, `boss/${b.id}.reveal.existence`);
  }
  for (const o of g.objectives) {
    refZone(o.zoneContext, `objective/${o.id}.zoneContext`);
    refLattice(o.availableFrom, `objective/${o.id}.availableFrom`);
    refLattice(o.completedAt, `objective/${o.id}.completedAt`);
    refLattice(o.reveal.existence, `objective/${o.id}.reveal.existence`);
  }
  for (const c of g.connectors) {
    refZone(c.fromZone, `connector/${c.id}.fromZone`);
    refZone(c.toZone, `connector/${c.id}.toZone`);
    refLattice(c.traversalGate, `connector/${c.id}.traversalGate`);
  }

  // honesty surfacing: every unverified node is a human-QA TODO (eval §0 boundary)
  const unverified = [
    ...g.zones,
    ...g.abilities,
    ...g.bosses,
    ...g.objectives,
    ...g.connectors,
  ].filter((n: any) => n.qaStatus === "unverified");
  for (const n of unverified)
    issues.push({
      severity: "warn",
      where: (n as any).id,
      message: "qaStatus=unverified — needs human gate verification before this (game,mode) ships",
    });

  return issues;
}

function detectCycle(nodes: LatticeNode[], issues: Issue[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen,1=onstack,2=done
  const visit = (id: string, path: string[]): boolean => {
    const node = byId.get(id);
    if (!node) return false;
    const s = state.get(id) ?? 0;
    if (s === 1) {
      issues.push({
        severity: "error",
        where: `lattice/${id}`,
        message: `cycle in partial order: ${[...path, id].join(" -> ")}`,
      });
      return true;
    }
    if (s === 2) return false;
    state.set(id, 1);
    for (const r of node.requires) if (visit(r, [...path, id])) break;
    state.set(id, 2);
    return false;
  };
  for (const n of nodes) visit(n.id, []);
}
