# Game Coach — Build Plan (Intent-Routed Multi-Mode Voice Coach)

> Current canonical plan. Evolution: real-time → pause-driven (see `latency-teardown.md`)
> → attempt-centric → **intent-routed multi-mode**. Generated 2026-06-12 across three design
> workflows (latency teardown, pause-driven design, multimode generalization), each with
> adversarial critics. API facts verified against the claude-api reference.

## 1. Product

A **pause-driven, push-to-talk voice coach** for console games (PS5/Switch via HDMI capture → an
Apple Silicon Mac). The player pauses, **holds a physical button, and asks out loud**; a cloud
Claude agent answers by voice, multi-turn, grounded in a rolling ~10–15 min video buffer and a
precomputed per-game knowledge base. **Not real-time** (rejected: distracting + technically
marginal — the teardown found the reactive tier infeasible). Latency is a UX target (2–5s to first
audio for quick turns; spoken filler for deep analysis), not a hard constraint — which lets us pick
the best model per turn.

**The spine is intent, not attempts.** The organizing question is not "segment the player's
attempts and analyze them" but **"understand the current situation → classify what they're *asking
for* → gather exactly the evidence that question needs → answer at the right depth."** A cheap
pre-call classifier emits an `INTENT_PLAN`; the main agent runs on it (model tier, tool scope,
frame policy, honest degradation disclosure) before the expensive call starts. "Attempts" demote
from the backbone to *one evidence source owned by one intent (DIAGNOSTIC)*.

**The non-obvious consequence: support is per-(game, mode), not whole-game.** An open-world RPG with
no clean attempt boundaries can ship INSTRUCTIONAL + INFORMATIONAL + NAVIGATIONAL on day one with
DIAGNOSTIC marked unsupported — the coach says "I can't break down attempts in this game" and still
answers the rest. **This makes the product *honest about supporting fewer* modes per game, not
magically more** (see the per-genre reality in §8).

---

## 2. Architecture

```
                     OFFLINE: KB-BUILD PIPELINE (per game, batch, versioned per patch)
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ Sources: wikis · guides · VIDEO (walkthroughs/boss-guides/puzzle-solutions) — see §7.2  │
 │   ▼ Claude structured outputs + Message Batches (50% off) + VLM-over-video keyframes    │
 │ Typed GAME GRAPH (C3 namespace): bosses/phases · zones+CONNECTORs · quests · items/UNLOCKS│
 │   + STAT/synergy tables · marker-lattice · reference keyframes · clip pointers           │
 │   ▼ SPOILER reveal-gates (existence + detail + connector-traversability) · per-mode      │
 │     capability manifest · graph-validation + red-team leak eval (fails build)            │
 └───────────────────────────────────────┬────────────────────────────────────────────────┘
                                          │ immutable, versioned KB + capability manifest
                                          ▼
 ───────────────────────────────── ONLINE: ONE HOST (Apple Silicon Mac) ────────────────────
 ┌───────────────┐  ┌──────────────────────┐  ┌────────────────────────────┐
 │ HDMI capture  │  │ coach-captured daemon │  │   voice-loop (Swift app)    │
 │ (UVC)→ffmpeg  │─▶│ segment ring · CANON  │◀─│ OWNS button+mic+STT+audio · │
 │  segment ring │  │ TIMELINE · GameState+ │  │ PTT machine · on-device STT │
 └───────────────┘  │ health · freeze-frame │  │ · ElevenLabs Flash v2.5 TTS │
   button bus ─────▶│ · frame-fetch API     │  └────────────┬───────────────┘
                    └──────────┬────────────┘               │ turn struct (C1)
                               │                              ▼
                    ┌──────────▼──────┐         ┌──────────────────────────────────┐
                    │ attempt-segment │         │ ROUTER: Haiku 4.5 json_schema →   │
                    │ (DIAGNOSTIC     │────────▶│ INTENT_PLAN (C7)  [separate call, │
                    │  evidence only) │         │ never in the warm cache prefix]   │
                    └─────────────────┘         └───────────────┬──────────────────┘
                                                                 ▼
                                          ┌────────────────────────────────────────┐
                                          │ MAIN AGENT (Sonnet 4.6 / Opus 4.8)       │
                                          │ frozen tool SUPERSET, tool_choice-scoped │
                                          │ 7 frame policies dispatched by intent ·  │
                                          │ query_kb/query_progression (spoiler-     │
                                          │ filtered server-side, fail-closed) ·     │
                                          │ reference-frame & clip-pointer grounding │
                                          └───────────────┬──────────────────────────┘
                                              streamed text → TTS → spoken answer (+ clip to phone)
```

The online subsystems share locked contracts **C1–C7** (§9). Per-intent behavior is *composition
over one frame service + one resolver + one fail-closed retrieval boundary* — reuse, not rebuild.

---

## 3. Intent taxonomy (MECE — partitioned by evidence shape)

| Intent | Example questions | Evidence | Frame policy | Tier | Game-signal requirement |
|---|---|---|---|---|---|
| **DIAGNOSTIC** | "Why do I keep dying here?" | attempt history + death-window frames | `diagnostic_death_window` (§5.3) | Opus 4.8 (N-attempt) / Sonnet (just-died) | ≥1 segmentable attempt; death/victory/respawn banners, healthbar HUD, boss-name OCR |
| **INSTRUCTIONAL (solve)** | "How do I solve this puzzle/phase?" | current frozen scene hi-res + KB mechanics + narration | `current_scene_highres` (1 frame @2576px) | Sonnet 4.6 | healthy freeze-frame + scene fingerprint → KB node |
| **INSTRUCTIONAL (missing)** | "What am I missing? I'm stuck." | current scene **+ recent-path sample** (binding evidence = what they haven't done) | `current_scene + path_sample` | Sonnet 4.6 | current frame + fingerprintable buffer |
| **NAVIGATIONAL** | "Where do I go? What next? I'm lost." | location + recent path + **progression belief** + KB progression graph; NO death events | `location + path_sample + optional map-screen` | Sonnet (low) / Opus (route-planning) | zone-fingerprint index + progression graph + a progression signal |
| **INFORMATIONAL** | "What is this item/enemy/symbol?" | one on-screen entity → KB entity; **reveal-gated** | `single_entity_zoom` (1 frame) | Haiku / Sonnet | entity fingerprint resolves |
| **EVALUATIVE / OPTIMIZATION** *(new)* | "Is this build good? Am I under-leveled?" | player's persistent character/inventory/stat state (OCR) + KB balance/synergy slice | `stats_screen_capture` (menu handshake, hi-res OCR) | Sonnet / Opus | OCR-able stat surface + KB stat-table |
| **META** | "Repeat that. No spoilers. Set my progress. Stop." | none | `none` | voice-loop / no-tool Sonnet | none |

**Why MECE:** the discriminator is *what evidence grounds the answer*, and the shapes are disjoint
and exhaustive over groundable questions — history / current-scene / recent-path / progression /
single-entity / persistent-state / death-decoupled-motion / no-evidence.

**EXECUTION is explicitly scoped *out* at launch, not faked.** "How do I parry this?" / combo
timing / rhythm games need motion sampling decoupled from a death event — the only motion policy
(the death-window) is death-gated. The coach says *"I can't coach button timing — but I can tell
you what this attack does and how to respond,"* and routes to INSTRUCTIONAL. Fighting/rhythm/
precision-platformer genres are marked EXECUTION-unsupported. A future `execution_motion_window`
policy (samples the last N s around a button press, backed by a KB frame-data asset) is reserved as
a named extension point so the spine never has to change to add it.

---

## 4. The router

A standalone `client.messages.create` on **`claude-haiku-4-5`** with `output_config.format:
{type:"json_schema"}`, run **before** the main call. Input is text-heavy: transcript + compact
`GameState` JSON + recent-event summary + the per-(game,intent) capability descriptor. Output:
`INTENT_PLAN` (C7). It is a *separate call*, never a tool of the main model and never inside the
main conversation, so it **cannot invalidate the warm Sonnet/Opus cache prefix**.

- **Why json_schema (corrected):** structured outputs are **GA on Haiku 4.5** and guarantee a
  parseable `INTENT_PLAN` so the orchestrator never recovers from malformed routing. *(The prior
  design's "prefill 400s on Haiku 4.5" rationale was wrong — prefill removal is on Fable 5 / Opus
  4.6–4.8 / Sonnet 4.6, not Haiku 4.5. Haiku 4.5 also does **not** support `output_config.effort`,
  so the classifier *names* a depth field, it doesn't set effort on itself.)*
- **Classification:** `primary_intent` + confidence, optional `secondary_intent` + confidence,
  `depth`, in one shot, with GameState as a free prior.
- **Ambiguity / multi-intent:** high confidence + large gap → route primary. Small gap → serve the
  **narrowest/cheapest** satisfying intent first; persona offers the expansion ("want me to also
  break down why you keep dying?"). **GameState breaks near-ties deterministically** — and weights
  *negative* signals as much as positive: stable/just-changed zone + **no healthbar + no recent
  death + idling/moving** → strong NAVIGATIONAL prior (a lost player phrases the question every
  way); character-sheet open → EVALUATIVE; healthbar present → INSTRUCTIONAL/DIAGNOSTIC. True
  compound → run primary at `depth=high` with the secondary's `evidence_plan` appended to the
  *same* Opus turn under the C5 compound cap; at low/medium, defer the secondary to a follow-up.
- **Degradation when a mode is unsupported here:** read the capability descriptor *at route time*;
  route to the best supported sibling (NAVIGATIONAL→INSTRUCTIONAL, DIAGNOSTIC→INSTRUCTIONAL,
  EVALUATIVE→INFORMATIONAL), set `degraded_from` + a pre-loaded `disclosure_phrase` so the coach
  *speaks the honest bound before* the loop. Default unknown intents to `degraded`, never `full`.

---

## 5. Subsystems

### 5.1 Trigger + Capture (`coach-captured` daemon)
Owns the **video** path, the **canonical timeline (C2)**, GameState (+ capture-health), and the
**button bus** — not the mic/STT (C1).
- On-disk ffmpeg `segment`-muxer ring (`segment_time≈2s`, keyframe-aligned via `force_key_frames`),
  strftime-named (not `segment_wrap`, which overwrites by index and leaves the live segment partial);
  crash-survivable; segment→capture-seconds index from ffmpeg's own `segment_list` CSV (C2).
- **Retention is consumer-gated, not time-gated (REVISED 2026-06-13).** The buffer is *not* a fixed
  ~15-min ring that overwrites on a clock. Media is **retained until every registered consumer has
  watermarked past it** — primarily the **progression-extraction** pass (§6 ledger), plus any open
  DIAGNOSTIC/evidence consumer. The janitor reclaims only the prefix of segments whose `end_t ≤
  min(consumer watermarks)`; un-analyzed media is never dropped. Rationale: a clock-based ring can
  overwrite a milestone event (ability-get, boss-kill, shortcut) before the detector runs, silently
  corrupting the progression belief; consumer-gating guarantees every frame is analyzed *before* it's
  eligible for reclaim. **What persists is the derived ledger, not the pixels** — once extraction has
  run over a span, the raw media is reclaimable; the tiny event ledger is what survives.
- **Disk safety valve (the honest cost).** 1080p60 ≈ 5–7 GB/hr, so unbounded "retain-until-analyzed"
  is a disk-growth risk if analysis lags. Bounded by: (1) keep extraction near-online so the
  un-analyzed backlog stays small; (2) a configurable disk ceiling that, on pressure, **forces/
  accelerates the extraction pass** on the oldest un-analyzed span rather than blind-deleting; (3)
  last resort, transcode the oldest un-analyzed span to a low-bitrate **analysis proxy** (keep enough
  pixels for milestone detection, drop full-res) instead of losing it outright. The invariant —
  *never reclaim un-analyzed media* — holds; only the fidelity of the retained copy degrades under
  pressure.
- `get_frame(capture_t, resolution)` + `cut_clip(t0,t1)` (the C5 frame service); button adapters
  (Stream Deck plugin primary; CGEventTap/Hammerspoon HID fallback) feed one event bus; the
  voice-loop owns the state machine. On DOWN: latch T0, freeze GameState, grab the freeze-frame.
- `coach_pause@T0` marker so the segmenter never treats the coaching pause as an attempt boundary.
- Capture-health is first-class (`signal_present`, `hdcp_blocked`, `last_good_frame_age`) →
  freeze-frame returns a health flag, not a black JPEG → real "I'm not getting a clear signal"
  branch.

### 5.2 Attempt Segmentation (now a DIAGNOSTIC-only evidence source)
Lazy, at trigger time, never a real-time loop. Two-pass cheap-signals-first: Pass 1 (no LLM) sparse
decode + `blackdetect`/`scene` + OpenCV `matchTemplate` (KB death/respawn/healthbar templates) +
pHash on a HUD crop; Pass 2 sends only ambiguous candidates to **Haiku 4.5** at ~512px (~190 vision
tokens) with json_schema. Background scans via **Message Batches (50% off)**; the hot boundary at
trigger gets one synchronous Haiku call. `activity_key` resolves to a **KB entity ID (C3)**. Honest
coverage: low-confidence boundaries not force-split; every `Attempt` tagged `truncated`/`missing`
(C4). Invoked *only* when the router selects DIAGNOSTIC.

### 5.3 Per-intent evidence & frame selection (7 policies on one frame service)
The §3.3 death-window algorithm becomes **one of seven `frame_policy_id`s** dispatched from the
`INTENT_PLAN`, all on the same C5 service / C2 timeline / C4 coverage / frozen tool union. An
**availability probe** checks (intent → required evidence) against capture-health, segmentation
records, and the KB descriptor *before any frame spend* → AVAILABLE / DEGRADE / UNSUPPORTED + the
reason to speak.
- **DIAGNOSTIC** (preserved verbatim): `segment_attempts` → contact-sheet grid to find the window →
  full-res `get_frames` on the accelerating-density death window (−3.5s→+0.5s, densest at impact) →
  one-row-per-attempt cross-attempt diff grid (comparison is cheaper than single-attempt analysis).
- **INSTRUCTIONAL (solve):** current frozen frame at Opus high-res (2576px single-image, ~4784
  vision tokens) + KB mechanics + narration. Cheapest mode.
- **INSTRUCTIONAL (missing):** same frame **+ path sample** (binding evidence = what they haven't
  done). Default to including the cheap path sample when the classifier can't distinguish.
- **NAVIGATIONAL:** §6.
- **INFORMATIONAL:** single-entity zoom (1 frame) + `query_kb`, **reveal-gated** — describe what is
  *visibly on screen now*, not the entity's future role (added to the red-team spoiler eval).
- **EVALUATIVE:** `stats_screen_capture` — agent asks the player to open the character sheet and
  re-trigger (the C1 handshake), OCRs hi-res, cross-references the KB stat-table. The new hardest
  problem (§10); ships behind a high MVK bar.
- **META:** `none`.

### 5.4 Voice Loop (native Swift/SwiftUI, Apple Silicon, macOS 26)
Single owner of button + mic + STT + audio + the PTT machine (C1). On-device Apple
SpeechAnalyzer/SpeechTranscriber primary (free, private, sub-200ms), Deepgram Nova-3 behind an
`STTProvider` seam for noisy input. ElevenLabs Flash v2.5 over a warm WebSocket (~135ms TTFB),
fed Claude's stream **sentence-by-sentence**. Hold-to-talk with on-device VAD endpointing
(button-DOWN arms, button-UP hard-stops — natural 8–15s questions without truncation). Barge-in =
button during SPEAKING → ducks TTS, cancels the Claude stream + tags async batch jobs with the turn
id for discard, reopens the mic; fresh freeze-frame only on a **confirmed new DOWN**. Mandatory
spoken acknowledgement on deep-turn UP ("Let me look at your last few attempts…"). Transcript +
listening/thinking/speaking indicator shown; headset mic recommended.

### 5.5 Coaching Agent
Agentic loop on the Claude Messages API. Router (Haiku) → main call: **Sonnet 4.6** ($3/$15, 1M ctx,
`effort:low/medium`) for quick/cheap intents; **Opus 4.8** ($5/$25, 1M ctx, `thinking:{type:
"adaptive",display:"summarized"}`, `effort:high`) for deep N-attempt / route-planning. API is
stateless (full history resent). Tools are a **frozen superset** (C6) scoped per turn via
`tool_choice`. Spoiler filtering enforced **server-side at the retrieval boundary**, fail-closed
against the C6 marker — the model can't leak what it never received. Persona: concise spoken coach
(2–4 sentences quick; verdict + "want the breakdown?" deep), pre-agreed uncertainty phrasing. Can
hand off a **clip pointer to the companion phone** when a maneuver is easier shown than told (§7.2).

---

## 6. Navigational mode deep-dive

**Progression is a confidence-tagged belief, never a fact** — the console gives pixels, not save
state, and the buffer sees only ~10–15 min. **But the frames are ephemeral while the derived
progression is not.** As frames pass the capture scan, a background **milestone detector** (reuse
the §5.2 cheap-signals-first pipeline — template/pHash + occasional Haiku confirm — with a broader
event vocabulary: ability-get, item-get, boss-victory, zone-first-entry, shortcut/lever) appends to
a **persisted progression LEDGER** that outlives the ring buffer. The ledger maintains the C6 marker
incrementally and — critically — captures **world-state gates the inventory menu cannot see**
(opened shortcuts, pulled levers, non-key boss kills).

**Ranked signals (declining reliability):** (1) player-set C6 marker (authoritative floor); (2)
**menu-read bootstrap / re-anchor** — one-shot abilities+inventory vision read; the only signal that
recovers history from *before* the coach began observing (cold start) and that corrects ledger
drift; (3) **progression ledger** — continuous, friction-free, catches non-inventory events, but
only accrues from when observation began; (4) on-screen map/quest-log OCR via the map handshake; (5)
recent-buffer path (corroboration-only — blind to anything older than the window); (6) KB graph
reachability from the marker.

**Fail-closed fusion:** every source feeds the C6 marker as a **monotonic, downward-closed floor
that only high-confidence events *raise*** — never an automatic downward override. Over-crediting
progress (a false-positive boss-kill) would un-gate spoilers and misroute — the dangerous direction;
under-crediting is merely safe-but-stale. Ambiguous ledger events stay **advisory** until a menu
re-anchor or player confirmation promotes them; strong tells are authoritative. Event-signal
strength varies by game (HK has no universal victory banner — some kills are inferred only from an
item popup or an area opening), so the detector's per-event confidence drives promotion.

**"Minimal sufficient direction" spoiler principle:** retrieval is *structural graph traversal*,
not vector search — resolve current zone, take the marker as the frontier, compute objectives whose
prerequisites AND reveal-gates are ≤ frontier, return **only the next actionable hop**, never the
chain. Reveal the next door, not the route.

**Usefulness fixes (the first design optimized safety into uselessness):**
- A **usefulness bar parallel to the safety bar**: per game, a minimum fraction of "where do I go"
  turns must yield a *concrete destination* (measured on real spoken sessions) or NAVIGATIONAL ships
  **DEGRADED** and the catalog says so — not silent turn-by-turn degradation.
- **Audible, confirmable location + frontier** led in the first clause ("Looks like you're in the
  lower aqueduct and you've got the grapple — from here, head…") so a misresolve is caught in the
  same breath, not after a wrong turn.
- **Verbal/pixel assertion relaxes a stale marker (with confirmation)** — a stale marker otherwise
  bricks nav for engaged players ("go back to the swamp" about a swamp they finished is the fastest
  trust-killer); the floor is *raised by confirmation*, never silently overridden.
- **Map handshake is a fallback, best-effort answer first** — handing homework to a lost player
  inverts the premise; give the best passive-signal answer, then offer "open your map and I'll
  read it."
- **Open-world default routes the main-quest spine + one disambiguating question** ("pushing the
  story, or cleaning up side stuff?") rather than arbitrarily picking among open objectives.

**Honest bound:** *can* give useful, spoiler-safe next-hop directions on linear/metroidvania shapes
with good fingerprints and a current marker; *cannot* reliably help an open-world player who is lost
precisely because nothing in-game is helping and whose marker is stale — there, confidence is
anti-correlated with how lost they are, and the honest output is a one-question clarifier.

---

## 7. Knowledge base

### 7.1 The game graph
A single typed **GAME GRAPH** in the C3 namespace: boss/puzzle/mechanic/item nodes plus **ZONE/ROOM**
(gated CONNECTOR edges), **OBJECTIVE/QUEST** (ORDERS/PREREQ), **ABILITY/KEY-ITEM** (UNLOCKS), and
**STAT/ITEM-TABLE + synergy** nodes (EVALUATIVE). A **progression-marker lattice** (a partial order
of OCR/fingerprint-detectable milestones) is the single coordinate the C6 marker maps onto; every
reveal-gate references a lattice node, so lore gating and spatial/quest gating share one
machine-checkable mechanism.

**Per-game KB tiers** (map onto the per-mode descriptor): **T0** zones+connectivity+marker lattice+
next-hop objectives (NAVIGATIONAL); **T1** item/ability locations+unlocks; **T2** instructional
mechanics + vector index (INSTRUCTIONAL/INFORMATIONAL); **T3** diagnostic boss/attempt assets
(DIAGNOSTIC); **T4** stat tables + synergy graph (EVALUATIVE — richest, most patch-volatile).

### 7.2 Video knowledge ingestion (the richest source — and the most under-built)
For games, **video is usually the richest knowledge, and the transcript is its *least* valuable
part.** "Dodge here" as text is useless; the value is the pixels showing exactly *what* to dodge.
Principle: **don't reduce video to its transcript — extract its visual knowledge.** Two payoffs
text can't give:

- **Reference keyframes that ground the coach's own vision.** Running a VLM over a boss-guide video
  offline yields *canonical labeled frames* ("the boss's pose 8 frames before the sweep"). At play
  time the coach compares the player's death-window frames against these expert-labeled examples
  ("you're eating the overhead slam — the tell is the left-arm raise; you're rolling too early").
  The coach's vision goes from "describe what I see" to "match against known-good." Biggest unlock.
- **Clip hand-off, because voice is terrible at spatial/visual info.** With clip pointers (video id +
  timespan) per entity, the coach hands the player a precise 20-second clip on the companion phone
  ("easier shown than told") — voice for the diagnosis, canonical clip for the execution. Direct
  synergy with the push-to-talk + companion design, and the primary delivery for NAVIGATIONAL routes
  and INSTRUCTIONAL puzzle solutions.

**Pipeline (offline/batch, part of KB-build):**
1. **Acquire** (`yt-dlp` video + subs) **with a real rights strategy** — derive structured
   knowledge under fair-use rather than redistributing video; link back to source timestamps; or
   license / partner with creators. The dominant constraint before scale (§10).
2. **Multimodal segmentation** — cut into entity-aligned chunks via transcript + scene cuts +
   **YouTube chapter markers** (creators label "Phase 2", "Lever Puzzle", "Path to the Citadel" —
   free structure).
3. **Vision-language extraction per segment** — sample keyframes, run Claude over `[keyframes +
   transcript span]` → structured entity fields **+ reference keyframes + a clip pointer**. *Same
   vision machinery as the play-time coach, pointed at expert footage* — the deepest reuse in the
   system.
4. **Cross-source fusion** — many videos per boss; fuse, resolve conflicting strategies, weight by
   agreement + recency + signal, track provenance per claim (clickbait/wrong guides are common).
5. **Spoiler alignment** — walkthroughs are linear and progression-revealing; use the video's own
   progression position to assign reveal-gates (feeds the same gate machine as §7.3).
6. **Index** — entities → graph; segment summaries → vector index; reference keyframes → keyframe
   store keyed to entities; clip pointers → hand-off.

**Honest hard parts:** quality variance (fusion + source weighting), VLM-over-video cost
(offline/batch, keyframe-sampled, amortized per game — still real), visual matching at play time
(treat reference frames as VLM *context examples*, not pixel-match templates — angle/build/lighting
differ), and rights *at scale* (deliberately deferred — prove ingestion works first, then seek
rights; do not pre-gate the capability on it).

**STATUS (2026-06-13): BUILT, runnable.** General multi-game pipeline in `ingest/`
(acquire→segment→keyframes→VLM-extract→fuse→validate). Mechanical stages run for real (a HK
walkthrough downloaded + 40 keyframes sampled); VLM extraction + fusion gated only on an API key.
Output is a schema-conformant `graph.ingested.json` that flows into the reveal-gate eval; all
generated nodes are `qaStatus: unverified` (candidate, not authority — eval §0). Adding a game = a
`sources/<game>.json` file, no code change.

### 7.3 Spoiler reveal-gates
Gate **entity existence**, not just detail (name only entities whose existence-gate ≤ frontier;
phrase directions relative to a *revealed* landmark). Gate **connector traversability** — the leak
is often relational ("head through the gate to the north" implies a passable gate, itself the
spoiler); the red-team eval flags any asserted traversal whose CONNECTOR gate > frontier, and the
coach falls back to a non-directional instructional answer rather than a hedged direction. The
fail-closed `query_kb`/`query_progression` filter drops gated nodes server-side before Claude sees
them.

### 7.4 Pipeline mechanics
Claude structured outputs (json_schema) + Message Batches (50% off) + a prompt-cached shared-source
prefix. New stages: graph validation (connectivity soundness, marker monotonicity) + the red-team
inference-leak eval that **fails the build**. Versioned per game patch (patches reroute zones, move
items, rebalance stats → graph + lattice + gates re-validate). Human-QA gate signs off entity
coverage, spoiler correctness, segmentation-asset accuracy, and the **per-mode capability manifest**
before a (game, mode) is marked supported.

---

## 8. Mode-granular support + launch scope

**Per-(game, mode) capability vector** replaces the whole-game bit. Each (game, mode) is gated by a
per-mode **minimum-viable-KB bar** AND per-mode **on-screen signal requirements** (FULL only if
both clear; DEGRADED if one is partial; UNSUPPORTED if either absent). NAVIGATIONAL adds a third
gate: a live **resolve/usefulness rate** (§6). Stamped into the versioned KB as a manifest, surfaced
in the catalog, enforced fail-closed at route time.

**The honest per-genre reality (don't oversell the mechanism):** INSTRUCTIONAL + INFORMATIONAL are
near-universal and cheap; DIAGNOSTIC is narrow (needs clean attempt boundaries — soulslike/
metroidvania bosses); **NAVIGATIONAL is expensive, spoiler-risky, and realistically DEGRADED on the
open-world games it's meant to unlock**; EVALUATIVE is the richest KB + most brittle OCR. Set
expectations and KB investment against this.

**Diverse launch set (5–6 titles, most supporting a mode *subset* — that's the point):**
- **Soulslike / boss-gated action** — DIAGNOSTIC full, INSTRUCTIONAL full, NAVIGATIONAL/EVALUATIVE degraded.
- **Linear story/adventure w/ set-piece puzzles** — INSTRUCTIONAL + NAVIGATIONAL full, DIAGNOSTIC degraded.
- **Metroidvania** — DIAGNOSTIC + INSTRUCTIONAL + NAVIGATIONAL full (the title proving all three).
- **Dedicated puzzle game** — INSTRUCTIONAL + NAVIGATIONAL full, DIAGNOSTIC **unsupported** (proves value with no diagnostic).
- **Open-world RPG** — NAVIGATIONAL (honestly DEGRADED) + INSTRUCTIONAL full + **EVALUATIVE full** (the build/loadout exemplar of the reframe), DIAGNOSTIC unsupported.

**Excluded genres:** **multiplayer/competitive** (pause-incompatible; no static-KB analog for
opponent-dependent metas) — catalog-level filter blocks onboarding. **Roguelikes** mark NAVIGATIONAL
unsupported (procedural maps defeat the static graph; the marker is meaningless across runs) — their
value is EVALUATIVE + INFORMATIONAL over run state, which is *why* EVALUATIVE was added.

**Catalog + degradation:** each tile shows per-mode chips ("Why am I dying — yes; How to solve —
yes; Where do I go — limited; Is my build good — not yet"), manifest-driven. UNSUPPORTED → one-line
spoken redirect to a supported mode; DEGRADED → answer + spoken reduced-confidence bound (C4 honesty
extended to "I can't reliably track where you are, so take directions as rough").

---

## 9. Contracts (C1–C7)

- **C1 — turn struct:** voice-loop solely owns mic+button+STT; daemon does video only. Carries
  `{transcript, stt_confidence, t0_anchor, gamestate_snapshot (incl. capture-health + KB-entity
  activity id), freeze_frame_ref, clip_ref?}`. **+ `pending_evidence_request_id`** so the map/stats
  handshake can stitch two player turns into one evidence gather (consume the next DOWN as the
  map/stats frame, or detect a new question and abandon gracefully; short TTL).
- **C2 — canonical timeline:** one monotonic capture-seconds clock; all frame/segment addressing by
  it; byte offsets forbidden.
- **C3 — one KB-entity-ID namespace:** GameState id == `activity_key` == agent `boss_id` == KB
  entity id, via one fingerprint+OCR resolver (now also resolving zones, on-screen entities, and
  stat-screen regions).
- **C4 — coverage/health honesty end-to-end:** capture exposes window bounds + health; segmentation
  tags `truncated`/`missing`; `segment_attempts` returns coverage; the coach speaks honest bounds.
  Extended to intent-level via the descriptor + disclosure phrases.
- **C5 — one frame-materialization service:** `(timeline, resolution) → stable Files-API file_id`,
  shared, cached, **+ a service-enforced compound-turn cap** (rejects requests over 100 img / 32MB /
  2576px single-image / ~2000px many-image; returns structured "budget exceeded" so the agent drops
  the secondary `evidence_plan`). Force-defer: at depth=high with two evidence shapes, the secondary
  gets one establishing grid, never a second death-window.
- **C6 — per-model cache + locked tools + sound progress marker:**
  - **Frozen tool SUPERSET per tier, locked at deploy:** `{segment_attempts, get_frames,
    scrub_to_event, query_kb, query_progression, read_screen_overlay, read_stats_screen}`. No
    post-launch tool-set mutation. Per-intent narrowing via `tool_choice` (does NOT bust the cache;
    only tool-definition changes / model switches bust the byte-0 prefix). Distinct warm caches per
    tier (Sonnet/Opus), each warmed once per session, optionally pre-warmed at session open.
  - **Per-turn scoping channel:** mid-conversation `role:"system"` (`mid-conversation-system`
    beta). **VERIFY before P3:** confirmed on Opus 4.7+/4.8, *unconfirmed on Sonnet 4.6*. If Sonnet
    rejects it, the cache-safe **`<system-reminder>` user-turn block becomes the primary Sonnet
    channel** (sits after the cached prefix). **Security:** spoiler-relevant scoping (KB slice /
    frontier) must NOT ride the spoofable user-turn channel — if Sonnet can't take `role:"system"`,
    that decision is made server-side in the fail-closed `query_*` filter.
  - **Marker = a downward-closed set of reached lattice nodes** (the only shape for which `gate ≤
    frontier` is well-defined; an antichain of toggles silently over-reveals on a partial order).
    Player-owned, one-breath-settable; lattice closure underneath.
- **C7 — INTENT_PLAN (new, cloud-orchestrator-owned):** `{primary_intent, primary_confidence,
  secondary_intent?, secondary_confidence?, depth, evidence_plan, frame_policy_id, degraded_from?,
  disclosure_phrase?, progress_marker_snapshot (read-only copy of C6 — router never writes it),
  kb_version}`. **KB-version pinning:** router stamps the descriptor version V; `query_*` must
  execute against V or the orchestrator degrades — capability promise and queried data stay
  atomically consistent across patch-rollout skew.

---

## 10. Phasing

- **P1 — prove the spine on the cheap, near-universal modes.** INSTRUCTIONAL + INFORMATIONAL
  (current-scene + single-entity, both reveal-gated) across 2–3 diverse titles. Lightest signal bar,
  warmest cost; de-risks the router, frame-policy dispatch, the C3 resolver-as-narrator ("looks like
  you're at the windmill puzzle — yes?"), and the per-(game,mode) descriptor, without the hard modes.

  > **P1a (RESOLVED 2026-06-13 — supersedes the "cheap modes first" framing for the first slice).**
  > Goal chosen: **experience-first vertical slice** (prove the product feels good + the physical
  > loop is reliable), and **confront the scariest correctness surface — spoiler-safe nav — first**,
  > rather than the cheapest mode. Decisions:
  > - **Game:** Silksong (or Hollow Knight) — metroidvania, the §8 three-mode exemplar; Switch
  >   capture (no HDCP on gameplay output); huge corpus; a game we'll actually dogfood so triggers
  >   are real, not staged.
  > - **Mode:** **NAVIGATIONAL only, hardcoded** (no router yet). Chosen over DIAGNOSTIC/INSTRUCTIONAL
  >   because it's the question this genre actually provokes ("I'm lost, where now"). Accepts that P1
  >   is *not* cheap: it front-loads the **T0 game-graph KB + reveal-gates + spoiler red-team eval**
  >   (the scariest surface), trading loop-feel breadth for killing the unrecoverable-spoiler risk early.
  > - **Progress belief — SIMPLIFIED to a menu read (key insight).** Do *not* infer progression from
  >   gameplay pixels or a verbal claim. Use the **abilities/inventory menu handshake** (reuse C1
  >   `pending_evidence_request_id` + the §5.3 stats-screen / §6 map handshake — *no new machinery*):
  >   "open your abilities and re-trigger" → vision/OCR the static hi-res menu → derive the marker as
  >   ground truth. In a metroidvania most gates are ability/item-represented, so this covers the
  >   dominant nav constraint and **eliminates the stale-marker trust problem (§6)**. Cache per
  >   session; refresh on new pickup. Residual: world-state gates (opened shortcut, lever, non-key
  >   boss kill) aren't in inventory → the menu read alone is a **lower bound**. **Closed by the §6
  >   progression ledger:** P1a ships the menu-read bootstrap first (it alone makes nav work), then
  >   the background ledger is the immediate P1a+ increment — marginal cost is low (frames are
  >   already scanned) and it captures exactly the non-inventory events the menu misses. Until the
  >   ledger lands, the fallback for a next-hop hinging on a non-item gate is **one** targeted confirm
  >   ("opened the City of Tears yet?"), not a general "where are you."
  > - **Location:** current-zone freeze-frame fingerprint (C3 resolver).
  > - **Answer shape:** reveal-gated **next hop only** (never the chain), led by an **audible
  >   location + what-you-have + next-hop readback** so a misread is caught in one breath (§6).
  > - **Rig:** Stream Deck trigger (worn-clicker couch spike in parallel, non-blocking); single
  >   **Sonnet 4.6** call; hand-authored **T0 graph + reveal-gates for the opening ~3–4 zones**;
  >   **spoiler red-team eval gates the build from commit one** — spec'd in
  >   `spoiler-redteam-eval.md` (authored *before* the graph; graph is built against it).
  > - **Bar:** "I'm lost" → spoken readback you confirm → a concrete, correct, non-spoiling next
  >   destination, at ≥ the §6 usefulness rate, measured on real dogfood sessions. Ships
  >   **DEGRADED-labeled**, honestly. **Does NOT test** high-frequency loop-feel (that's the
  >   DIAGNOSTIC trade we deferred) — P1b adds the router + a cheap sibling mode + a second title.
- **P2 — DIAGNOSTIC** (the preserved spine, now one mode): soulslike/metroidvania attempt path;
  proves the per-mode model (full there, unsupported on puzzle/open-world titles).
- **P3 — NAVIGATIONAL, hardened**: structural retriever, marker-lattice + downward-closure invariant,
  audible-location + marker-relaxation fixes, usefulness bar, relational reveal-gate eval,
  map-handshake-as-fallback. **Probe `mid-conversation-system` on Sonnet 4.6 and lock the scoping
  channel here.** FULL only where resolve + usefulness bars clear; DEGRADED (honestly) on open-world.
- **P4 — EVALUATIVE** (last): richest/most patch-volatile KB tier, most brittle OCR, and **no
  fail-closed safety floor** — needs its own evidence policy, KB asset, and QA gate before shipping
  even DEGRADED.
- **EXECUTION** out-of-scope for launch; `execution_motion_window` reserved as a no-spine-change
  extension.
- **Cross-cutting (folds into P1→P4):** the video-knowledge pipeline (§7.2) — reference keyframes
  land with DIAGNOSTIC/INSTRUCTIONAL (P1–P2), clip hand-off with NAVIGATIONAL puzzle/route delivery
  (P3); the rights strategy must be settled before scaling ingestion.

---

## 11. Risks & open decisions

**New hardest unsolved problem — EVALUATIVE (persistent character state):** no clean fail-closed
floor. A wrong build rec isn't a spoiler that degrades to "vaguer but safe" — it wastes the player's
irreversible resources, with no conservative direction to fail toward. Plus the richest, most
patch-volatile KB and the most brittle OCR. The honest frontier.

**Residual risks:** NAVIGATIONAL safe-but-useless on the hard open-world case (mitigated by the
usefulness bar + DEGRADED labeling, not eliminated); a mis-tagged per-mode descriptor routes
confidently into unsupported territory (red-team it in QA; default unknowns to `degraded`); relational
spoiler leak for nav reduced but not eliminated; stat-table volatility outpaces patch QA with no
floor to catch it; classifier mis-route asymmetry (default depth conservative; log + retune offline);
**video rights at scale** (the dominant KB-pipeline risk); VLM-over-video cost.

**Open decisions (genuinely open):**
- **Trigger hardware + couch ergonomics** (still the most UX-defining unknown: remapped controller
  combo captured console-side vs worn BT ring/clicker vs on-controller). Validate from the couch
  before P1 hardens.
- Marker-lattice granularity (coarse per-region vs precise per-objective) — likely per-game.
- Whether to ever build EXECUTION, or leave fighting/rhythm/precision genres permanently out.
- Open-world EVALUATIVE/roguelike retriever ranking among many open objectives with no stated goal.
- DEPTH levels (3 vs 2) — empirical, measured P1/P3.
- Where conversational META runs (voice-loop vs no-tool Sonnet) — likely split.
- Confidence-gap / depth-escalation / FULL-vs-DEGRADED cutoffs — tuned against a labeled set of real
  spoken questions per game shape (router observability log).
- **Must resolve before P3:** the Sonnet 4.6 `mid-conversation-system` probe (sets whether the
  security-sensitive scoping channel is `role:"system"` or server-side-only).
- **Video:** rights model (fair-use-derived vs licensed vs creator partnership) and the VLM-over-video
  cost ceiling — worth its own focused pass before scaling ingestion.
```
