# Ingested knowledge bases — build status (2026-06-13)

Both KBs were **machine-built from text + video** by `ingest/` — no hand-authoring. Both validate
structurally (0 errors); every node is `qaStatus: unverified` (candidate, not authority — eval §0).

| Game | Sources (ok/total) | Segments (text+video) | Graph nodes | Validation |
|---|---|---|---|---|
| Hollow Knight | 8/8 | 75 + 10 | 430 (63 zones · 30 bosses · 50 abilities · 108 objectives · 39 connectors · lattice) | 0 err / 287 unverified |
| Memories in Orbit | 6/7 | 10 + 9 | 241 (46 zones · 24 bosses · 29 abilities · 26 objectives · 9 connectors · lattice) | 0 err / 134 unverified |

Rebuild (extractions are cached, so free):
```sh
npx tsx ingest/cli.ts ingest hollow-knight
npx tsx ingest/cli.ts ingest memories-in-orbit
```

## What worked

- **Generality proven.** Memories in Orbit — a game with no hand-authored knowledge and not in the
  model's training depth — was learned from scratch: real zones (The Vessel, Metropolis, The Severed
  Spine), bosses (Egis, FLORA, ATI), ability systems (Hairpin Grapple, Modifiers, Nacre). Adding it
  was *only* a `sources/*.json` file.
- **Text = backbone, video = grounding.** HK's 63 zones / 50 abilities came from 5 wiki pages; video
  added visual keyframe evidence + boss-guide specifics.
- **Spoiler filter flows through.** The fail-closed filter runs on the *generated* graph: at game
  start, late-game entities (The Radiance, Hollow Knight, City of Tears, Shade Cloak, Deepnest) are
  correctly forbidden.

## Fusion-quality layer — BUILT (`ingest/refine.ts`)

A post-fuse refine stage now runs automatically and writes `quality.json` (every classification +
source-support, nothing silent):

1. **Entity-vs-descriptor classifier — done.** Drops relative-description / hedge nodes. Caught all
   8 MiO artifacts (`Unknown Area`, `Crow boss fight (prior segment)`, `Prior to Metropolis`,
   `First ability (Dwellings)`, `Powerful new ability (post-Flora)`, `Bosses (general)`…) and 1 HK.
2. **Cross-source agreement scoring — done.** Each node scored by distinct-source support from
   provenance. Corroborated (≥2 sources): 86 HK / 14 MiO — the real backbone (Dirtmouth, Greenpath,
   City of Tears, Deepnest, Crystal Peak…). Single-source flagged (the contamination signal): 200
   HK / 133 MiO — kept, not deleted. `--drop-singletons` removes them (removes contamination AND
   legit rare entities — a deliberate, reported tradeoff, off by default).

Graph stays valid through refine: dropped zones repoint to a kept `Unknown Area` fallback, dangling
connectors removed, lattice preserved. `graph.raw.json` keeps the pre-refine version.

## LLM sweep — BUILT (`ingest/llm-sweep.ts`, run with `--llm-sweep`)

A Haiku pass classifies every NAMED entity (zones/abilities/bosses — not objectives) for
`belongsToGame` (cross-game contamination) + `isRealEntity` (descriptor hedges), batched + cached,
fail-open. Refine drops high-confidence (≥0.6) contamination/artifacts. Results:

- **HK:** removed 17 contamination + 8 artifacts. The contamination is genuinely Silksong —
  **Pharloom, Bonebottom, Coral Forest, Moss Temple, the Needle/Silk abilities** — all gone; real HK
  (Greenpath, City of Tears, Deepnest, 106 objectives) preserved.
- **MiO:** removed 17 contamination + 2 artifacts.

**Honest false-positive rate:** ~3 of HK's 17 flags are real HK over-flagged (Tower of Love, Spell
Twister Charm). That's why nothing is auto-`verified` — every verdict is in `quality.json` with
confidence for human review. Two lessons baked in: objectives must NOT be swept (they're action
phrases — caused mass false drops until excluded); and the membership check is good, not perfect.

## Honest quality work still remaining

- **Sweep false positives** — a confident LLM still mislabels a few real entities. A second
  independent verdict (panel) or grounding the check in the wiki's own category data would cut it.
- **Single-source flag is a signal, not a filter** — a rare-but-real entity is single-source too.
- **Provisional lattice.** Progression order is a linear walkthrough approximation; the reveal-gate
  eval + multi-source order cross-checking harden it.

The capability — *produce a real, validated, spoiler-gateable, quality-scored game graph from
internet text+video, for any game* — is demonstrated end-to-end for two games.

## Auto-QA verifier — BUILT (`ingest/verify.ts`, run with `--verify`)

Replaces per-node human review with: **ground in the ingested corpus → corroborate across distinct
PUBLISHER domains (not pages) → adversarial panel on every entity (grounding+provenance+game-knowledge
as evidence) → escalate only low-confidence calls.** Human effort goes O(nodes) → O(escalations).

Results (after publisher-counting + always-panel + cleaner sources — Fextralife/gamerwalkthroughs for
HK, MiO wiki bosses/abilities pages):
- **HK:** Pharloom/Bonebottom/Needle/Silk all DROPPED (0.92–0.98) — Silksong contamination gone;
  Confessor Jiji / Greenpath KEPT. 20 dropped (all Silksong/junk). **Escalations: 0.**
- **MiO:** ATI (Keeper of the Heart), Dr Halyn's bosses, Nacre items KEPT (were wrongly dropped
  pre-fix); corroboration 14→57.
- **Escalations: 0 on BOTH games** after the retry fix (below). The previously-stuck MiO items now
  get real high-confidence keeps (Egis/Flora 0.99, slingshot 0.94, crystallized_nacre 0.75). Human
  review surface for these two games: **zero**.

Key lesson that made it work: corroboration must count **distinct publishers**, not pages — 5 pages
of one contaminated wiki is one voice (this is what fake-corroborated Pharloom). And grounding must be
*evidence for the panel*, never an auto-decision (contaminated text auto-kept Silksong; thin text
auto-dropped video-only reals).

Fixed (the conf-0 artifact): the panel now **retries skipped refs** (a long batch came back short),
with smaller batches (12) + more output room (8000 tok); non-verdicts after retries escalate but are
NOT cached. Result: escalations 25→0. (Gotcha caught along the way: the first attempt cached the bad
conf-0 fallbacks, so the cache had to be purged once.)

Remaining hardening (optional): a second independent panel to cut residual single-panel error; and
the membership check could be grounded in the wiki's own category data for popular games.
