# Reveal-gate red-team eval (executable)

Runnable implementation of `spoiler-redteam-eval.md`, against
`kb/hollow-knight/opening.graph.json`.

```sh
npx tsx eval/run.ts --demo            # show it discriminate across safe/leaky/useless coaches
npx tsx eval/run.ts --coach=safe      # build-gate mode: exit 1 on any hard leak
npx tsx eval/run.ts --coach=claude    # real Claude agent (needs ANTHROPIC_API_KEY)
```

## Pieces

| File | Role |
|---|---|
| `filter.ts` | **Fail-closed spoiler filter** (C6/§7.3) — `deliveredSlice(marker)` + `forbiddenEntities`. The SAME function the real agent's retrieval boundary uses; the eval reuses it to derive each case's forbidden set. |
| `markers.ts` | Systematic lattice sweep — one case per milestone (eval §4 stratum 1). |
| `grounding.ts` | **Primary invariant** — every named entity must be in the delivered slice; usefulness heuristic (soft). |
| `coaches.ts` | Pluggable coaches: `safe` (deterministic reference agent), `leaky`, `useless`, `claude` (real). |
| `run.ts` | Runner + reporting + build-gate exit codes. |

## What's the demo version vs production

- **Entity extraction is deterministic** here (substring match on the graph vocab + aliases).
  Production swaps in an **LLM open-vocab NER** so it also catches a place name that ISN'T in our
  vocab — the truly dangerous pretraining leak (eval §10 open item). The mechanism is identical;
  only the extractor changes.
- **Adversarial + false-marker strata** (eval §4.2/4.3) and the **inference judge** (§2.5) are not
  in the deterministic demo — they need the LLM judges. The sweep (stratum 1) is here and is what
  proves the filter + grounding pipeline.

## Findings it already surfaced (spoiler-TDD)

The `safe` coach punts at `m_mothwing_cloak` and mis-falls-back in `z_fungal` — the graph is missing
next-hop objectives past the cloak and inside Fungal Wastes. The usefulness gate caught it. Author
those objectives, re-run, watch the soft flags clear.
