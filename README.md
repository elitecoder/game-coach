# game-coach

An AI coach for console games. It watches live gameplay from an HDMI capture card, builds a
knowledge base for any game from wiki text and YouTube video, and answers questions without
spoiling content the player hasn't reached yet. It has knowledge bases for two games:
**Hollow Knight**, the first target, and ***Memories in Orbit*** (MIO), added to test whether
the pipeline generalizes.

The project started as a *real-time* gameplay assistant. Measuring latency end to end showed that
real-time coaching on this hardware hits physical limits, so the product became a coach you
consult while the game is paused, plus an overlay that warns about hazards *before* you reach
them. The design analysis that led to that change is in [`docs/`](docs/).

**Stack:** TypeScript (Node), Python (NumPy/Pillow), ffmpeg/AVFoundation, Claude (Sonnet for
vision and answers, Haiku for classification and contextualization), Transformers.js embeddings,
yt-dlp.

---

## Highlights

- **Knowledge-base ingestion for any game.** Wiki pages and YouTube videos are segmented,
  keyframed, extracted into structured data with Claude vision, fused, refined and auto-verified
  into a typed game graph (zones, bosses, abilities, objectives, connectors and a progression
  lattice). Adding a game takes one `ingest/sources/<game>.json` file.
  - Hollow Knight: **480 nodes**. *Memories in Orbit*: **464 nodes**. The model had essentially no
    prior knowledge of *Memories in Orbit*, so that graph shows the pipeline learns a game from its
    sources rather than from pretraining.
- **Auto-QA instead of human review.** Each entity is grounded in the ingested corpus, then
  corroborated by counting distinct *publishers* rather than pages. Five pages from one
  contaminated wiki count as one source, and that rule is what exposed Silksong entities leaking
  into the Hollow Knight graph. An adversarial LLM panel then rules on every entity, and only
  low-confidence calls are escalated. The human review queue went from O(nodes) to O(escalations),
  and the last run had 0 escalations for both games (`kb/INGESTED_STATUS.md`).
- **Spoiler safety tested before it was built.** The red-team eval (`eval/`) was written before
  the game graph. It runs a fail-closed spoiler filter over every progression milestone, checks
  that every entity a coach names comes from the content the player has unlocked, and works as
  a build gate: the reference coach has 0 hard leaks, a deliberately leaky coach is caught on 9
  of 10 cases, and an unhelpful coach is flagged on 10 of 10. Grounding is the main check because
  the model already knows Hollow Knight from pretraining, so filtering retrieval alone isn't enough.
- **Hybrid RAG.** BM25 and embeddings are combined with reciprocal-rank fusion. Chunks are
  embedded with Anthropic-style *contextual retrieval*: an LLM writes a short context line for each
  chunk, cached by content. Answers are scored with a RAGAS-style LLM-judged eval (faithfulness,
  answer and context relevancy) plus a deterministic retrieval-hit check (`rag/`).
- **Capture daemon** (`src/`). An ffmpeg mpegts segment ring that survives crashes, a canonical
  timeline measured in capture-seconds, a frame and clip service, and honest capture-health
  reporting (it returns a reason instead of a black frame). Retention is
  **retain-until-analyzed**: media is deleted only after every consumer's watermark has passed it,
  never on a timer.
- **Live overlay** (`coach/`). Mirrors the captured frame and draws an arrow from the player to the
  on-screen target with a 1–4 word instruction ("jump right to ledge") and a hazard warning.
- **A damage detector trained without the HUD** (`perception/`). A classical-CV HUD reader (the
  "teacher") counts the health masks on screen and auto-labeled **4,878 damage events across
  45.6 hours** of a 62-hour YouTube corpus, with no human labeling. A 1.4M-parameter
  video+audio CNN (the "student") was then trained to detect damage with the HUD **blacked out**,
  so it works where no HUD is readable. Results with thresholds fixed on validation videos
  before testing:

  | Held-out set | Student | No-training flash baseline |
  |---|---|---|
  | 3 test playthroughs (different channels), 829 hits | **F1 0.71** (P 0.95, R 0.56) | F1 0.16 |
  | Own Switch capture: 1.2 h, 1080p, video only, checked by hand | **27 of 29 real hits, 0 false alarms** | 1 hit |
  | False Knight: 3 YouTube guide videos, 10 hits | F1 0.56 | F1 0.06 |

  It isn't just detecting "a fight is happening": scored only on the 20-second windows around
  hits, average precision is 0.66–0.89 against a 5–9% base rate. Auditing the teacher by eye
  found three label bugs, each fixed before the current model was trained:
  - It treated an empty soul vessel as "no HUD", so every low-soul moment was unlabeled.
  - It misread masks against bright backgrounds.
  - It discarded hazard hits, because the screen fades to black on respawn.

  On the author's own footage the model makes fewer mistakes than the teacher that labeled its
  training data. Details: [`docs/damage-detector.md`](docs/damage-detector.md).

## Games

| | Hollow Knight | *Memories in Orbit* (MIO) |
|---|---|---|
| Sources (`ingest/sources/`) | 8 wiki/guide pages + 3 YouTube videos | 9 wiki/guide pages + 2 YouTube videos |
| Graph nodes | 480: 58 zones, 30 bosses, 42 abilities, 121 objectives, 41 connectors, 188 lattice | 464: 69 zones, 39 bosses, 51 abilities, 92 objectives, 16 connectors, 197 lattice |
| Auto-QA | Silksong contamination removed (Pharloom, Bonebottom, Needle/Silk), 0 escalations | Real entities like ATI, Dr Halyn's bosses and Nacre kept after being wrongly dropped by an earlier version; corroborated entities 14 → 57; 0 escalations |
| Q&A (`coach review`) and retrieval index | yes | yes |
| RAG eval set (`rag/eval-sets/`) | 6 questions | 6 questions |
| Live overlay (`coach watch`) | yes (hand-written routes in `coach/goal.ts`) | not yet |
| Spoiler red-team eval | yes | not yet |
| Damage detector | yes | not yet |

MIO is the generality test. The model knows little about it from pretraining, nothing about it was
hand-authored, and adding it took only `ingest/sources/memories-in-orbit.json`. Every MIO zone,
boss and ability in its graph came out of the ingestion pipeline. `ingest`, `coach review` and the RAG
commands take `memories-in-orbit` as the game argument.

## Architecture

```mermaid
flowchart LR
  subgraph Live
    SW[Switch / console] -->|HDMI| CAP[UVC capture card]
    CAP --> D[capture daemon<br/>segment ring + timeline]
    D --> F[frame/clip service]
    F --> V[Claude vision<br/>scene read]
    V --> HUD[overlay HUD]
  end
  subgraph Offline
    SRC[wiki pages + YouTube] --> ING[ingest: segment → keyframes →<br/>extract → fuse → refine → verify]
    ING --> KB[(typed game graph<br/>+ provenance + QA verdicts)]
    KB --> IDX[contextual hybrid index]
  end
  V --> ASK[grounded Q&A]
  IDX --> ASK
  KB --> GATE[spoiler filter<br/>+ red-team eval]
```

## Design work

The code is backed by written design analysis:

| Doc | What it covers |
|---|---|
| [`docs/latency-teardown.md`](docs/latency-teardown.md) | Latency analysis of the real-time pipeline. Frames are already 40–210 ms old when the host receives them (capture card + USB delivery), and a reasoned tip costs about 1.6 s p50 / 3.9 s p95 even with cloud Claude. Reactive coaching under 300 ms is therefore infeasible for any reasoned tip. It also explains why cloud beats local on tail latency (shared SoC + thermals). |
| [`docs/design.md`](docs/design.md) | The full product and system design: 7 intent types defined by the kind of evidence each needs, a router, a per-intent frame-selection policy, contracts C1–C7, phasing and risks. |
| [`docs/spoiler-redteam-eval.md`](docs/spoiler-redteam-eval.md) | The spoiler eval spec: test strata, invariants, and why a grounding check comes before a filter. |
| [`docs/capture.md`](docs/capture.md) | Capture hardware (about $40 of UVC kit), setup, and the retention model. |

## Repo map

| Path | What |
|---|---|
| `src/` | Capture daemon: ffmpeg ring, timeline, frames, health, retention |
| `ingest/` | Multi-game ingestion: acquire → segment → keyframes → extract → fuse → refine → LLM sweep → verify |
| `kb/` | Game-graph schema, validator, and the built knowledge bases for two games |
| `rag/` | Contextual hybrid retrieval, grounded answers, LLM-judged eval |
| `eval/` | Spoiler red-team eval (fail-closed filter, grounding check, pluggable coaches) |
| `coach/` | `review` (Q&A at a pause) and `watch` (live overlay) |
| `perception/`, `training/` | HUD teacher, cache builder, HUD-free damage detector (`student.py`) and its trained weights |

## Running it

Requires Node 22+ and ffmpeg. Commands that call Claude need `ANTHROPIC_API_KEY` in `.env`.

```sh
npm install

# offline, no API key
npx tsx eval/run.ts --demo                                # spoiler eval: safe / leaky / useless coaches
npx tsx kb/validate.ts hollow-knight/graph.ingested.json  # structural check of the built KB

# capture (no hardware needed: test pattern or a local video file)
npx tsx src/cli.ts start --source=file:/path/to/gameplay.mp4

# coaching (capture running, API key set)
npm run guide -- review hollow-knight "how do I beat the Mantis Lords?" --sources
npm run guide -- review memories-in-orbit "how do I beat Egis?" --sources
npm run guide -- watch hollow-knight --goal=map

# rebuild a knowledge base (extractions are cached)
npx tsx ingest/cli.ts ingest hollow-knight
```

## Data

| In the repo | Not in the repo (fetched by scripts) |
|---|---|
| Built game graphs, provenance, QA verdicts (`kb/<game>/*.json`) | Source videos and transcripts (`kb/<game>/_raw/`) |
| LLM caches: extraction, sweep, verify and contextual-retrieval outputs (`kb/<game>/_*cache/`) | Keyframes (`kb/<game>/_keyframes/`) |
| Damage/death weak labels for the corpus (`training/labels/`) | The 62 h perception corpus (`training/corpus/`) |
| Exact sources: pinned video URLs (`ingest/sources/`), corpus video list (`training/corpus-urls.txt`) | The capture ring (`data/`) |

Third-party media is pinned by URL rather than re-hosted. A rebuild downloads the same sources,
and the content-addressed caches mean the LLM work isn't paid for again:

```sh
npx tsx ingest/cli.ts ingest memories-in-orbit --llm-sweep --verify   # downloads sources, extraction from cache
yt-dlp -f 'bv*[height<=480]+ba/b[height<=480]/b' --merge-output-format mp4 -o '%(id)s.%(ext)s' \
  -a training/corpus-urls.txt -P training/corpus
python3 training/verify_corpus.py   # IDENTICAL / SAME-STREAM / DIFFERENT per video
```

`training/corpus-manifest.json` records each video's title, channel, YouTube format, duration,
resolution and SHA-256, so a re-download can be checked against the exact files the labels came from.
Checked on 2026-11-08: all 16 videos were still up, and a fresh download was byte-identical. Use a
current yt-dlp: older versions get HTTP 403 from YouTube.

Caveat: three Memories in Orbit text chunks and two Hollow Knight ones were never cached, so an
offline rebuild produces slightly smaller graphs than the committed ones until those chunks are
extracted with an API key.

## Status and known limitations

This is a research prototype, not a product. The open problems, stated plainly:

- **Not a live, turn-by-turn guide.** The capture buffer plus a vision round-trip take several
  seconds, and identifying the current zone from a single frame is unreliable. The dependable use
  is when the player *names* the problem ("how do I beat X", "what does this charm do").
- **The spoiler filter isn't connected to the live Q&A path yet.** It is built and enforced in
  the eval, but `rag/ask.ts` still relies on a prompt instruction. Connecting the two is the
  highest-value next step.
- **The progression lattice is provisional.** It approximates a linear walkthrough, and parts of
  the Hollow Knight order are wrong, which breaks "what's next" questions.
- **Some contamination remains.** The verifier removes most Silksong entities, but a few
  references are still in the Hollow Knight graph.
- **The damage detector favors precision over recall.** Recall against the teacher is about
  0.56, with precision about 0.95. Audio adds little: YouTube commentary drowns out the game
  sound, and the capture daemon currently drops audio. Killing blows and deaths aren't modeled,
  and bright arenas (Colosseum, White Palace, Godhome) are mostly unlabeled. The hand-checked own
  footage is one session with 29 hits.

Gameplay footage and raw scraped sources aren't included in this repo (they're gitignored); the
fetch scripts recreate them. Hollow Knight is © Team Cherry and *Memories in Orbit* belongs to its
developers. This project isn't affiliated with either.
