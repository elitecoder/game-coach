import type { GameGraph } from "../kb/schema";

/**
 * The fail-closed spoiler filter (plan C6 / §7.3). This is the SAME function the real agent's
 * server-side retrieval boundary uses — the agent only ever receives the delivered slice, so it
 * cannot leak what it never got. The eval reuses it to derive each test case's forbidden set.
 */

export interface EntityRef {
  id: string;
  kind: "zone" | "ability" | "key_item" | "boss" | "objective" | "connector";
  name: string;
}

/** Downward closure of a marker under the lattice partial order (`requires`). */
export function reachedSet(graph: GameGraph, marker: string[]): Set<string> {
  const byId = new Map(graph.lattice.map((n) => [n.id, n]));
  const reached = new Set<string>();
  const visit = (id: string) => {
    if (reached.has(id)) return;
    const n = byId.get(id);
    if (!n) return;
    reached.add(id);
    for (const r of n.requires) visit(r);
  };
  for (const m of marker) visit(m);
  return reached;
}

export function allEntities(graph: GameGraph): EntityRef[] {
  return [
    ...graph.zones.map((z) => ({ id: z.id, kind: "zone" as const, name: z.name })),
    ...graph.abilities.map((a) => ({ id: a.id, kind: a.type, name: a.name })),
    ...graph.bosses.map((b) => ({ id: b.id, kind: "boss" as const, name: b.name })),
    ...graph.objectives.map((o) => ({ id: o.id, kind: "objective" as const, name: o.name })),
    ...graph.connectors.map((c) => ({ id: c.id, kind: "connector" as const, name: c.description })),
  ];
}

export interface Slice {
  entities: EntityRef[];
  ids: Set<string>;
}

/**
 * Entities the agent is allowed to receive (and therefore name) at this marker:
 *  - zone/ability/boss/objective whose `reveal.existence` gate is reached
 *  - connector whose `traversalGate` is reached (may be asserted passable — the relational leak, §7.3)
 */
export function deliveredSlice(graph: GameGraph, marker: string[]): Slice {
  const reached = reachedSet(graph, marker);
  const ok = (gate?: string) => gate != null && reached.has(gate);
  const entities: EntityRef[] = [];

  for (const z of graph.zones)
    if (ok(z.reveal.existence)) entities.push({ id: z.id, kind: "zone", name: z.name });
  for (const a of graph.abilities)
    if (ok(a.reveal.existence)) entities.push({ id: a.id, kind: a.type, name: a.name });
  for (const b of graph.bosses)
    if (ok(b.reveal.existence)) entities.push({ id: b.id, kind: "boss", name: b.name });
  for (const o of graph.objectives)
    if (ok(o.reveal.existence)) entities.push({ id: o.id, kind: "objective", name: o.name });
  for (const c of graph.connectors)
    if (ok(c.traversalGate)) entities.push({ id: c.id, kind: "connector", name: c.description });

  return { entities, ids: new Set(entities.map((e) => e.id)) };
}

/** Everything the agent must NOT name at this marker (its complement of the delivered slice). */
export function forbiddenEntities(graph: GameGraph, marker: string[]): EntityRef[] {
  const delivered = deliveredSlice(graph, marker).ids;
  return allEntities(graph).filter((e) => !delivered.has(e.id));
}
