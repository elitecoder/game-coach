# RESUME — picking this project back up

**Archived 2026-11-23.** Paused mid-way through training/evaluating the Hollow Knight
perception model. This note is the cold-start guide: what's done, what's safe, and the
exact next step.

## TL;DR state

- **Everything irreplaceable is in git and pushed to `origin/main`** — code, all 16
  video labels (`training/labels/*.json`), and the final trained model
  (`perception/models/hk-damage-v2/best.pt`).
- **The ~65 GB of local data is all regenerable** and may have been deleted to reclaim
  space (see "Rebuilding the local environment" below). Nothing unique lives there.
- Last milestone reached: **v2 HUD-free damage detector trained and evaluated.**

## What the model does / how good it is

A HUD-free "student" damage detector distilled from a classical-CV HUD "teacher"
(mask-count reader). Goal: detect the player taking damage from raw frames *without*
relying on the on-screen health HUD, so it generalizes to games/players with no visible
health bar.

v2 eval on held-out footage (`training/runs/v2/eval_test.json`, video `G1atkq4C1KU`):

| stream   | step-AP | precision | recall | f1   |
|----------|---------|-----------|--------|------|
| fused    | 0.753   | 0.996     | 0.54   | 0.70 |
| video    | 0.753   | 0.985     | 0.536  | 0.694|
| audio    | 0.382   | 0.767     | 0.45   | 0.568|
| baseline | 0.052   | 0.097     | 0.228  | 0.136|

Read: precision is excellent (~1.0 — almost no false damage calls), recall is the weak
spot (~0.54 — misses roughly half the hits). Fused ≈ video; audio adds little.

## Corpus & labels

- **16 videos, ~62 h** of Hollow Knight footage. Exact YouTube IDs are pinned in
  `training/corpus/archive.txt` — re-downloadable byte-for-identical via
  `training/fetch_corpus.sh` (yt-dlp `--download-archive`).
- Teacher labels for all 16 are committed in `training/labels/*.json` (damage + death
  events, median-smoothed, HUD-off videos quarantined). You do **not** need to re-label
  to continue — labels are the durable artifact, corpus is just the raw pixels.

## The exact next step (where it paused)

The plan was **"train and test on a couple early bosses."** Training is done; the pending
work is **boss evaluation**:

1. Pick 1–2 early-boss clips (e.g. Gruz Mother, False Knight) — either from the corpus or
   a fresh short capture.
2. Run the v2 model over them and check whether damage events line up with actual hits.
3. Known open issue (deferred, documented in `docs/damage-detector.md`): **deaths are
   under-counted** — death-fade frames get gated out by HUD-presence detection, so the
   death signal is unreliable. Damage is the solid signal; fix death detection before
   relying on it.
4. If improving: recall is the lever (currently ~0.54). Options noted in
   `docs/damage-detector.md`.

## Rebuilding the local environment (if the 65 GB was reclaimed)

```sh
cd ~/dev/game-coach
npm install                      # node_modules
python3 -m venv .venv-train && . .venv-train/bin/activate && pip install torch pillow numpy  # training venv (MPS on this Mac)
bash training/fetch_corpus.sh    # re-download the 16 pinned videos (~55 GB, slow)
# labels & the trained model are already in the repo — no retraining needed to resume
```

The RAG/ingest KB caches under `kb/*/_raw`, `_keyframes`, `rag-index.json` and `data/`
regenerate from the ingest pipeline; they're gitignored for the same reason.

## Pointers

- Architecture & design: `docs/design.md`
- Damage detector deep-dive + known issues: `docs/damage-detector.md`
- Capture hardware/setup: `docs/capture.md`
- Perception CV code: `perception/` (`mask_reader.py`, `label_video.py`, `hud_profiles/`)
- Public repo: https://github.com/elitecoder/game-coach
