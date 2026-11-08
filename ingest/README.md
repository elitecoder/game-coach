# Video knowledge ingestion (multi-game)

Implements plan §7.2 — turns internet walkthrough/guide **video** into the typed game graph the
coach traverses. **Game-agnostic**: adding a game is just a `sources/<game>.json` file; no code
changes. Output is a schema-conformant `kb/<game>/graph.ingested.json` that flows straight into
`kb/validate.ts` and the reveal-gate eval.

```sh
# mechanical stages only — no API key (downloads video, segments, samples keyframes)
npx tsx ingest/cli.ts ingest hollow-knight --no-extract --max-sources=1

# full pipeline incl. VLM extraction + fusion (needs ANTHROPIC_API_KEY or game-coach/.env)
npx tsx ingest/cli.ts ingest hollow-knight
```

## Pipeline (each stage = one module)

| Stage | Module | Needs key | Notes |
|---|---|---|---|
| 1. Acquire | `acquire.ts` | no | `yt-dlp` → 480p video + en subs + chapters + info JSON. `query`/`url` per source. |
| 2. Segment | `segment.ts` | no | chapter markers if present, else 90s windows; attaches transcript from SRT. |
| 3. Keyframes | `keyframes.ts` | no | ffmpeg samples K frames/segment @768px — the visual evidence. |
| 4. Extract | `extract.ts` | **yes** | Claude vision over [keyframes + transcript] → forced-tool schema fragment. Keyframes primary, transcript secondary (§7.2). |
| 5. Fuse | `fuse.ts` | no | dedupe by name, resolve refs, synthesize provisional lattice, wire reveal-gates, provenance sidecar. |
| (validate) | `kb/validate.ts` | no | structural check; all generated nodes are `qaStatus: unverified`. |

## What "ingested successfully" means — and its honest limits

A generated graph is a **candidate, never authority** (eval §0). Every node is `unverified`; the
lattice order is a *linear walkthrough approximation* (real progression is a partial order); gates
are heuristic guesses. The reveal-gate eval + human QA are what harden it. The pipeline's job is to
**produce the structure from real video at scale**, which is the thing that was missing.

Known refinements:
- **Transcript-rich + chaptered sources extract best.** A "no commentary" video has no transcript
  and often no chapters → keyframe-only extraction + window segmentation (still works, less rich).
- **Fusion is v1** — name-normalized dedupe + linear lattice. Conflict detection and agreement/
  recency weighting (§7.2 step 4) are stubbed (`conflicts.json`).
- **Lattice inference** from a single linear walkthrough is the weakest link; multi-source
  cross-checking is the real fix.

## Providing the key

Put it in a gitignored `game-coach/.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
# optional: COACH_EXTRACT_MODEL=claude-opus-4-8
```
