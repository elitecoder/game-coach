# Damage detector: a HUD-free student distilled from a HUD teacher

Goal: detect "the Knight just took damage" from gameplay video **without reading the health HUD**,
so the coach can follow a fight in footage where the HUD is hidden, off, or unreadable. Trained
2026-11-08 on an Apple M5 (MPS), about 1 hour per run. Current model: **v2**
(`perception/models/hk-damage-v2/`).

## Method

**Teacher (`perception/mask_reader.py`).** Classical CV: crop the mask row at fixed fractional
coordinates, threshold, count bright runs. It runs on every frame at 4 fps (480p). A frame counts as
"HUD readable" only when:

| Check | Why |
|---|---|
| The white swoosh above the soul vessel is lit, and at least 1 mask is counted | v1 checked the soul vessel itself, which is dark when soul is empty, so every low-soul moment was unlabeled (20% of the author's footage read as HUD-visible; 69% after the fix). Menus have no swoosh and the map has no masks. |
| The mask row's background is dark (≤20% bright pixels, 25th-percentile luma ≤90) | White Palace, white-outs, Radiance and the console home screen make the mask threshold count garbage. An audit found about 1 in 8 hits on bright frames was real. |

**Teacher → events (`student.py`, `teacher_events`).** Bridge HUD dropouts up to 1 s, median-5
smooth, and call a drop in mask count a hit:

| Rule | Why |
|---|---|
| HUD readable for 2 s before and after, and the lower count holds | An audit of 12 random hits found 4 false: 3 were the whole HUD fading out (cutscenes, transitions) and 1 was a YouTube edit cut. |
| Drops larger than 2 masks are ignored | Edits, save swaps |
| **Hazard hits:** the HUD fades out for up to 4 s and comes back 1 or 2 masks lower, then stays there | Spikes, acid and pits respawn you through a fade to black, which the stability rule threw out, so v1 never learned hazard hits. Deaths come back full and room transitions come back unchanged. Audit: 7 of 8 real. |
| A hit next to a dropout is placed before the dropout | Otherwise the label landed 0.75–1 s late, on the black fade frames |

Otherwise the hit is placed one step (0.25 s) before the HUD drop, because the HUD redraws about
0–0.75 s after contact. Result: **4,878 hits over 45.6 HUD-readable hours** of the 62-hour corpus
(v1 teacher: 4,916 over 37.9 h, including more false hits in bright areas).

**Student inputs (`perception/build_cache.py`).** 160x90 RGB at 4 fps with the HUD box
(x < 45%, y < 30%: masks, soul vessel, geo) zeroed, plus 64-bin log-mel audio at 100 Hz. One
window = 8 frames (2 s) + 2 s of audio around step t. `--masks-only` re-runs just the teacher.

**Model.** Per-frame CNN on [RGB, RGB minus the previous frame] → temporal conv → max-pool;
audio CNN on log-mel; late fusion. Modality dropout (audio 30%, video 10%), with a learned
"no audio" embedding, so the same weights run on silent sources. 1.4M parameters. Labels:
positive within ±1 step of a hit, ignored at ±2, negative elsewhere when the HUD is readable.
Balanced sampling 1:4, AdamW with a one-cycle schedule, 8 epochs, best checkpoint by validation
step-AP.

**Split by video (every video is a different channel).**

- Train: 8 playthroughs
- Val: dVzxepqI_Ps, On4avlp9h0M, Pt415sgn0JU
- Test: G1atkq4C1KU, WwHuCOzSAZk, K4A2RqfKmc0
- The two HUD-off videos were excluded: too little readable HUD for the teacher to vouch for.

Event thresholds were chosen on validation only (`threshold.json`). Events = peaks at least 1 s
apart, matched to teacher hits within ±1 s.

## Results

**Held-out YouTube videos**, scored against the v2 teacher:

| Set | Mode | Precision | Recall | F1 |
|---|---|---|---|---|
| Test playthroughs (829 hits) | fused | 0.95 | 0.56 | **0.71** |
| | video only | 0.94 | 0.55 | 0.70 |
| | audio only | 0.71 | 0.34 | 0.46 |
| | flash/motion baseline | 0.10 | 0.33 | 0.16 |
| False Knight guides (10 hits) | fused | 0.62 | 0.50 | 0.56 |
| | baseline | 0.03 | 0.70 | 0.06 |

v1, trained on the old labels and scored against the same v2 labels, is worse on every test video:
F1 0.66 / 0.63 / 0.80 vs v2 0.70 / 0.67 / 0.86, with step-AP 0.70 / 0.60 / 0.79 vs 0.75 / 0.64 / 0.87.

**The author's own Switch capture, checked by hand.** This is 1.2 h of HUD-visible play from one
session (Crossroads, Greenpath, Gruz Mother twice), captured at 1080p with no audio, on a device
and resolution the model never trained on. Every disagreement between the teacher and the model
was checked frame by frame. Ground truth is 29 real hits: 28 of the teacher's 31 hits (3 are false,
caused by glowing bugs drifting behind the mask row) plus a killing blow the teacher can't label.

| | Real hits detected | False alarms |
|---|---|---|
| v2 (threshold 0.97) | 27 / 29 | 0 |
| v1 (threshold 0.825) | 28 / 29 | 0 |
| HUD teacher | 28 / 29 (+3 false) | 3 |

- **v2's misses:** a spike hit scored 0.967 against a 0.97 threshold (v1 scored it 0.34, because v1
  had no hazard labels), and the killing blow scored 0.81.
- **v1's miss:** the spike hit.
- **Interpretation:** on this footage both models are at the ceiling and differ by one hit, which
  is noise. Sub-threshold peaks were checked too; they are nail strikes and a lifeblood cocoon
  breaking, not missed hits.

**Combat-confound check (`perception/analyze_eval.py`).** AP using only steps within 10 s of a hit.
A model that only learned "a fight is on screen" would sit near the base rate.

| | Base rate | v2 AP | v1 AP |
|---|---|---|---|
| Test videos | 5–9% | 0.77 / 0.66 / 0.89 | 0.73 / 0.64 / 0.82 |
| Own capture | 6% | 0.96 | 0.92 |

**Error audit (v1, 6 false positives and 6 misses on G1atkq4C1KU).** Most false positives show the
Knight visibly getting hit (Fog Canyon jellyfish, an explosion at 1 mask, White Palace saws). The
teacher rejected them because the HUD vanished or reset right after (death or respawn). Several
misses are teacher false hits (a boss title card, dream-sequence flashes). So scoring against
the teacher understates the student. This comes from a 12-example audit and is not a measured
correction.

## Known limits

- Recall against the teacher is about 0.56 on YouTube footage, with precision around 0.95. On the
  author's own footage, recall is 27 of 29.
- Audio adds little on top of video. Most of the corpus has commentary or music over the game
  sound. The author's capture currently drops audio altogether (`-an` in `src/capture.ts`).
- Killing blows aren't labeled: the HUD vanishes at death. Deaths aren't modeled.
- Bright arenas (Colosseum, White Palace, Godhome) are now mostly unlabeled rather than mislabeled,
  so the model sees few hits there.
- The False Knight sets are tiny (10 hits), and the own-capture check is one session with 29 hits.

## Reproduce

```sh
# 1. corpus (see README "Data") then the cache: one decode pass per video, ~1 h, ~39 GB
python perception/build_cache.py perception/hud_profiles/hollow-knight.json training/cache <id>=<video> ...
python perception/student.py events training/cache
# 2. train, calibrate, evaluate
python perception/student.py train training/cache training/runs/v2 \
  --val=dVzxepqI_Ps,On4avlp9h0M,Pt415sgn0JU --test=G1atkq4C1KU,WwHuCOzSAZk,K4A2RqfKmc0
python perception/student.py calibrate training/cache training/runs/v2 --val=dVzxepqI_Ps,On4avlp9h0M,Pt415sgn0JU
python perception/student.py eval training/cache training/runs/v2 G1atkq4C1KU WwHuCOzSAZk K4A2RqfKmc0 --tag=test
```

After a HUD-profile change, re-run only the teacher with
`build_cache.py ... --masks-only` (about 1 h for the whole corpus).
