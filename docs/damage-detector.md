# Damage detector: a HUD-free student distilled from a HUD teacher

Goal: detect "the Knight just took damage" from gameplay video **without reading the health HUD**,
so the coach can follow a fight in footage where the HUD is hidden, off, or unreadable. Trained
2026-11-08 on an Apple M5 (MPS), about 1 hour.

## Method

**Teacher (`perception/mask_reader.py`).** Classical CV: crop the mask row at fixed fractional
coordinates, threshold, count bright runs. It runs at native resolution on every frame at 4 fps.

**Teacher → events (`student.py`, `teacher_events`).** Bridge HUD dropouts up to 1 s, median-5
smooth, and call a drop in mask count a hit. Two filters came out of a manual audit:

| Rule | Why |
|---|---|
| HUD readable for 2 s before and after, and the lower count holds | An audit of 12 random hits found 4 false: 3 were the whole HUD fading out (cutscenes, transitions) and 1 was a YouTube edit cut. After the rule, at least 11 of 12 random hits on another video were real. |
| Drops larger than 2 masks are ignored | Edits, save swaps |

The hit is placed one step (0.25 s) before the HUD drop, because the HUD redraws about 0–0.75 s
after contact.

**Student inputs (`perception/build_cache.py`).** 160x90 RGB at 4 fps with the HUD box
(x < 45%, y < 30%: masks, soul vessel, geo) zeroed, plus 64-bin log-mel audio at 100 Hz. One
window = 8 frames (2 s) + 2 s of audio around step t.

**Model.** Per-frame CNN on [RGB, RGB minus the previous frame] → temporal conv → max-pool;
audio CNN on log-mel; late fusion. Modality dropout (audio 30%, video 10%), with a learned
"no audio" embedding, so the same weights run on silent sources. 1.4M parameters. Labels:
positive within ±1 step of a hit, ignored at ±2, negative elsewhere when the HUD is readable.
Balanced sampling 1:4, AdamW with a one-cycle schedule, 8 epochs, best checkpoint by validation
step-AP.

**Split by video (every video is a different channel).**

- Train: 8 playthroughs, 11.4k positive steps
- Val: dVzxepqI_Ps, On4avlp9h0M, Pt415sgn0JU
- Test: G1atkq4C1KU, WwHuCOzSAZk, K4A2RqfKmc0
- The two HUD-off videos were excluded: too little readable HUD for the teacher to vouch for.

Event thresholds were chosen on validation only (`threshold.json`). Events = peaks at least 1 s
apart, matched to teacher hits within ±1 s.

## Results

| Set | Mode | Precision | Recall | F1 |
|---|---|---|---|---|
| Test playthroughs (623 hits) | fused | 0.84 | 0.61 | **0.70** |
| | video only | 0.83 | 0.60 | 0.69 |
| | audio only | 0.73 | 0.39 | 0.50 |
| | flash/motion baseline | 0.10 | 0.54 | 0.18 |
| False Knight guides (12 hits) | fused | 0.50 | 0.42 | 0.45 |
| | baseline | 0.04 | 1.00 | 0.07 |
| Gruz Mother, own Switch capture (7 teacher hits) | video only | 1.00 | 0.86 | **0.92** |
| | baseline | 0.10 | 0.71 | 0.17 |

On Gruz Mother, the student fired on all 4 fight hits (t = 4082.5, 4086.2, 4088.8, 4091.8 s) at
about 1.0 confidence, plus 2 earlier hits, with no false alarms. Its one "miss" (t = 3838) is a
teacher artifact: a brief misread of 6 masks that the median filter didn't remove. The student
scored it 0.52, below the threshold. This source is a different device and resolution from
training, and has no audio.

**Combat-confound check (`perception/analyze_eval.py`).** AP using only steps within 10 s of a hit:
0.75 / 0.75 / 0.80 on the test videos (base rate 5–11%) and 0.91 on Gruz. A model that only
learned "a fight is on screen" would sit near the base rate.

**Error audit (6 false positives and 6 misses on G1atkq4C1KU).** Most false positives show the
Knight visibly getting hit (Fog Canyon jellyfish, an explosion at 1 mask, White Palace saws). The
teacher rejected them because the HUD vanished or reset right after (death or respawn). Several
misses are teacher false hits (a boss title card, dream-sequence flashes). So scoring against
the teacher understates the student. This comes from a 12-example audit and is not a measured
correction.

## Known limits

- Audio adds little on top of video. Most of the corpus has commentary or music over the game sound.
- Damage only. Death labels from the teacher are unreliable (the HUD vanishes at death).
- The False Knight sets are tiny (12 hits). Treat that F1 as indicative.

## Reproduce

```sh
# 1. corpus (see README "Data") then the cache: one decode pass per video, ~1 h, ~39 GB
python perception/build_cache.py perception/hud_profiles/hollow-knight.json training/cache <id>=<video> ...
python perception/student.py events training/cache
# 2. train, calibrate, evaluate
python perception/student.py train training/cache training/runs/v1 \
  --val=dVzxepqI_Ps,On4avlp9h0M,Pt415sgn0JU --test=G1atkq4C1KU,WwHuCOzSAZk,K4A2RqfKmc0
python perception/student.py calibrate training/cache training/runs/v1 --val=dVzxepqI_Ps,On4avlp9h0M,Pt415sgn0JU
python perception/student.py eval training/cache training/runs/v1 G1atkq4C1KU WwHuCOzSAZk K4A2RqfKmc0 --tag=test
```

Trained weights, thresholds and eval output: `perception/models/hk-damage-v1/`.
