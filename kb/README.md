# T0 game graph (KB)

The structural knowledge the NAVIGATIONAL coach traverses (plan §7.1). `schema.ts` defines the
types + `validateGraph` (§7.4 structural checks: reference integrity + lattice acyclicity);
`hollow-knight/opening.graph.json` is the P1a opening-zone instance.

```sh
npx tsx kb/validate.ts hollow-knight/opening.graph.json
```

## How it's authored: spoiler-TDD

1. **Lattice first.** Define the progression milestones and their partial order. The player's marker
   (C6) is a downward-closed set of these; "frontier" = the reached maxima.
2. **Gate every entity.** Each zone/ability/boss/objective/connector references lattice nodes for
   when it may be *named* (`reveal.existence`) and, for connectors, when it may be asserted
   *passable* (`traversalGate` — the relational leak, §7.3).
3. **Run the red-team eval** (`spoiler-redteam-eval.md`). The forbidden-set per test case is
   *derived from this graph*. Add a zone → run the sweep → fix gates until leak rate is 0 and the
   usefulness bar clears → only then mark the (game, mode) supported.

## The honesty boundary (eval §0)

`validateGraph` proves the graph is *structurally* sound and the agent can't *speak past* an
authored gate. It does **not** prove a human assigned the *correct* gate. Every node carries
`qaStatus`; `unverified` nodes are surfaced as warnings and **must be human-verified before ship**.

The current HK instance flags 10 unverified nodes — honest about real uncertainty:
- **Judgment calls** (`z_greenpath`, `z_fungal`, `o_go_greenpath`, the early connectors): is naming
  the *next* zone to a player a spoiler? Defensible either way; the eval + a human decide.
- **Genuine knowledge gaps** (`i_city_crest`, `a_mantis_claw`, `m_city_access`): exact item sourcing
  / reachability I wasn't certain of. `z_city_of_tears` + `c_fungal_city` are deliberately included
  as **gated fixtures** — beyond the P1a slice — so the eval can verify an early-marker player never
  hears "City of Tears."

## Next

- Resolve the 10 `unverified` flags against an HK reference (wiki/playthrough) — flip to `verified`
  or correct the gate.
- Add the menu-read → marker mapping (which abilities/items the §6 menu handshake reads, keyed to
  lattice nodes — `detectableBy: ["menu"]` marks them).
- Wire the eval harness to consume this graph (derive forbidden-sets, run the sweep).
