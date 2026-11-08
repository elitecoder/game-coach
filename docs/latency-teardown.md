# Real-Time Latency Teardown & Feasibility

> Adversarial latency analysis of the real-time game-coach pipeline (34 agents: per-stage
> teardown + skeptic verification + local-vs-cloud debate + judge). Companion to
> `design.md`. Generated 2026-06-12.

## 1. Verdict

**True real-time (sub-100ms glass-to-coach) is not achievable, and it is not close — not
because the software is slow, but because the pixels are already old before any code runs.**
Every GameState is built from a frame that is **40–210ms stale at the instant the host
receives it** (capture-card frame-store + USB + AVFoundation delivery), and that staleness is
silicon/USB physics you cannot pre-warm, pipeline, or buy your way out of on an Apple Silicon
laptop (no internal PCIe path). On top of that floor, any *reasoned* tip pays a
vision-encode/prefill tax of **~750ms (cloud) to ~1.4s+ (local)** that is recomputed cold on
every novel frame because the live keyframe is uncacheable.

**Irreducible end-to-end floor:**
- **Reactive micro-tip path** (local template/OCR + canned tip, no VLM, wired audio):
  **~220ms floor, ~300ms p50**. The *only* sub-second path, and it brushes the twitch budget
  only on wired audio.
- **Situational reasoned tip** (cloud Claude, fully optimized): **~1.6s p50 / ~3.9s p95** wired.

**Tier feasibility:**
- **Twitch (<300ms) — INFEASIBLE for any reasoned tip, both architectures.** ~150–400ms of
  capture + delivery + N-of-M temporal confirmation is spent *before inference begins*. Only a
  **local, no-VLM, precomputed-tip reflex path** fits, and even that needs wired output.
- **Situational (1–4s) — FEASIBLE, best on cloud Claude.** p50 ~1.6s fits comfortably; p95
  ~3.9s rides the ceiling. Pure-local is ~2.5s p50 / **~9.7s p95 uncontended** and worse once
  it shares the SoC with perception — out of budget at the tail.
- **Strategic — FEASIBLE on either, trivially in budget.**

**Recommended architecture: HYBRID.** Always-on perception, retrieval, the reactive reflex
path, and reactive TTS run **local on the Mac**; situational/strategic reasoning runs **on
cloud Claude (Haiku fast tier)** to keep the heavy uncacheable vision prefill off the one
memory-bandwidth-bound SoC that perception already saturates.

---

## 2. End-to-End Latency Budget

Verified/corrected per-stage figures (corrected upward from the optimistic plan where
reviewers flagged it). "Floor" = best achievable. "Hideable?" = can pipelining/pre-warming
remove it from the *serial critical path*.

### 2a. Cloud-Claude architecture (situational tier)

| # | Stage | Cloud p50 (ms) | Floor (ms) | Hideable? |
|---|-------|---------------:|-----------:|-----------|
| 1 | HDMI capture + card frame-store buffer | 85 | 40 | No (frame AGE unrecoverable) |
| 2 | USB transfer + UVC/MJPEG decode + colorspace | 38 | 18 | Partial (~2ms decode; frame age not) |
| 3 | AVFoundation frame delivery | 14 | 8 | Yes (overlaps prior frame) |
| 4 | Frame sampling / decimation gate | 110 | 17 | Yes IF ring-buffer + freshest-frame-select |
| 5 | **Perception inference (OCR + template + tiny-VLM)** | 1300 | 350 | Partial (decouple to 0.5–2fps; per-event VLM not) |
| 6 | GameState assembly + diff | 0.15 | 0.02 | Yes (non-blocking) |
| 7 | Event detection + N-of-M confirmation trigger | 120 | 0.2 | Partial (rule eval hidden; confirm window not) |
| 8 | Knowledge retrieval (LOCAL, in-process) | 28 | 7 | Yes (speculative, prewarmed index) |
| 9 | Prompt/context + image prep (resize+encode+b64) | 12 | 3 | Yes (speculative pre-prep → ~0) |
| 10 | **Coach inference — Claude Haiku, streaming** | 1300 | 750 | Partial (RTT hidden; TTFT + cold vision prefill not) |
| 11 | Tip post-processing / formatting | 2 | 0.5 | Yes (per-sentence, streamed) |
| 12 | TTS time-to-first-audio (cloud, warm WS) | 235 | 70 | Mostly (overlaps LLM streaming) |
| 13 | Audio playback (wired DAC) | 6 | 6 | No (terminal) |

### 2b. Local-on-device architecture (situational tier)

| # | Stage | Local p50 (ms) | Floor (ms) | Hideable? |
|---|-------|---------------:|-----------:|-----------|
| 1 | HDMI capture + card frame-store buffer | 85 | 40 | No |
| 2 | USB + UVC decode + colorspace | 38 | 18 | Partial |
| 3 | AVFoundation frame delivery | 20 | 8 | Yes (but local VLM pegs same SoC → fatter tail) |
| 4 | Frame sampling / decimation gate | 170 | 17 | Yes w/ ring buffer (throttle collapses fps) |
| 5 | **Perception inference (OCR+template+tiny-VLM)** | 1300 | 350 | Partial |
| 6 | GameState assembly + diff | 0.5 | 0.02 | Yes (adds IPC vs cloud) |
| 7 | Event detection + confirmation | 120 | 0.2 | Partial |
| 8 | Knowledge retrieval (local, in-process) | 28 | 7 | Yes (contends w/ VLM for GPU/ANE → tail) |
| 9 | Prompt/context + **on-device ViT encode** | ~800–2000 | 600 | Hard to hide (pre-encode steals SoC, hurts p95) |
| 10 | **Coach inference — local VLM (prefill+decode)** | 4200 | 1400 | Partial (decode streams; vision-encode+prefill not) |
| 11 | Tip post-processing | 5 | 0.5 | Yes (2–5x inflation under contention) |
| 12 | TTS first-audio (local Kokoro/MLX) | 110 | 70 | Mostly (2.1s cold-start trap if warmup lapses) |
| 13 | Audio playback (wired) | 6 | 6 | No |

*Don't double-count the on-device ViT encode:* the corrected local coach figure (p50 4200ms)
already includes vision-encode + image-token prefill + decode. Stage 9's "~800–2000ms" only
exposes where that cost lives; in the serial sum it is counted **once** inside coach inference.

### 2c. Recommended HYBRID — serial critical path

Stages 1–7 are shared, local, pre-fork. Then two paths fork after the event trigger:

**Reactive reflex path (local, no VLM, no network):**

| Segment | p50 (ms) | Notes |
|---------|---------:|-------|
| Capture + decode + delivery (1–3) | ~137 | shared; un-hideable frame age dominates |
| Fast-path template/OCR tell (subset of 5) | ~30 | ANE/Metal, every frame, bypasses tiny-VLM |
| 2-of-3 confirmation + trigger (7) | ~33 | aggressive confirm at 30–60fps fast-path cadence |
| Canned/precomputed tip lookup (8) | <1 | hashmap by (boss, phase, event) |
| Local TTS first-audio (12) | ~110 | primed Kokoro/MLX |
| Audio playback, wired (13) | ~6 | |
| **Reactive total** | **~175 p50 / ~223 floor (wired)** | **~300 p50 on Bluetooth** |

**Situational reasoned path (cloud Claude):**

| Architecture | Situational p50 | Situational p95 |
|---|---:|---:|
| **Hybrid (cloud coach), wired** | **~1.6s** | **~3.9s** |
| Hybrid (cloud coach), Bluetooth | ~1.7s | ~4.2s |
| Pure-local coach, M4 Max, uncontended | ~2.5s | **~9.7s** (out of budget) |

**What pre-warming / pipelining removes from the serial sum:**
- **Frame sampling quantization (~50–100ms):** eliminated by a 30–60fps decoded ring buffer +
  freshest-frame-select instead of wait-for-next-tick.
- **TLS/TCP handshake (~100–300ms cold):** → ~0 via one persistent warm-pooled HTTP/2 connection.
- **Static prompt prefill:** up to ~85% TTFT reduction on the system+KB prefix via prompt
  caching; only the live keyframe prefills cold.
- **Retrieval (~28ms) + image prep (~12ms):** → ~0 on the hot path via speculative dispatch on
  the coarse event signal, overlapping the confirmation window.
- **TTS first-audio (~110–235ms):** mostly shadowed by streaming the first LLM clause into TTS.
- **Model cold-start (~21.7s VLM / ~2.1s TTS):** paid once at session launch behind the load screen.
- **NOT removable:** capture frame age (40–210ms), the N-of-M confirmation window (200–800ms by
  design), and the cold per-frame vision prefill (750ms cloud / 1.4s+ local). These are the floor.

---

## 3. Top Bottlenecks That Decide Feasibility (ranked)

**#1 — Cold per-frame vision prefill (the reasoning tax).** Every coaching event sends a
*novel* keyframe (720p = 1196 vision tokens; 1080p downscaled = 1560), and it **cannot be
prompt-cached** — Anthropic's cache invalidates on image presence, and MLX's vision-cache
speedup only applies to *repeated* images. So the encoder+prefill runs cold every tip:
**~750ms floor / 1300ms p50 cloud**, **~1.4s floor / 4.2s p50 local**. *Mitigation:* crop to
the action/HUD ROI (~400 tokens), cap visual tokens hard (256–512); cloud-side cache only the
static prefix and stream first clause to TTS; local-side use a light-encoder VLM
(FastVLM/Moondream-class). Largest controllable number in the pipeline — and why the
situational tier exists but the twitch tier does not.

**#2 — Capture-card frame staleness (the un-engineerable floor).** The card can't emit byte
one of frame N until it has clocked the whole frame in over HDMI, de-serialized, and usually
re-encoded: **40ms floor, 85ms p50, 210ms p95**. The optimistic plan's 25ms floor was wrong —
it borrowed an internal-PCIe figure for a USB-only platform and misread OBS's "30–40ms" as
absolute card latency (it's the *spread between* cards, which sit at ~40–100ms). *Mitigation:*
HD60 X / Cam Link 4K-class card, native YUY2/uncompressed (no in-card MJPEG round-trip),
explicit low-latency mode, USB 3.1+. Swings the stage 150ms+. **But absolute frame age is
unrecoverable** and alone kills the twitch tier.

**#3 — Memory-bandwidth contention on the local SoC (why local loses the tail).** Apple
Silicon LLM inference is bandwidth-bound (tok/s ≈ bandwidth/model-size). The pipeline *already*
runs a perception VLM (1300ms p50 / 3500ms p95) + OCR/template every frame. Adding a coach VLM
forces two bandwidth-bound jobs to split one ~273–540 GB/s bus; the verified local coach
numbers (4.2s p50 / 9s p95) are *uncontended* singles. Real contention drives 1.3–1.8x → coach
p50 climbs to ~2.9–3.5s, brushing/breaching the 4s ceiling. *Mitigation:* keep the heavy coach
off-device; if local is mandatory, drop perception to OCR/template-only when the coach fires.

**#4 — Laptop thermal throttling over a real session.** A session is 30–120 min of continuous
load. M3/M4 Max sustained GPU clocks drop ~0.7–1.7GHz within minutes; 14-inch/Air chassis
throttle harder, clamshell-mode loses up to ~50% sustained. *The* driver of open-ended local
p95 and of frame-sampling fps collapse (10fps → 3–5fps doubles the gate's quantization wait).
*Mitigation:* prefer a Mac mini/Studio for the perception host, validate under sustained load
(not a cold 30s test), and surface a tier-downgrade when throttling is detected.

---

## 4. Local LLM vs Claude — the recommended split

**Run on the Mac (local, always-on):**
- **Perception:** OCR (`.fast`, cropped HUD ROI, Neural Engine) + template/scene match
  (Metal/OpenCV) every frame; a **small VLM (Moondream-2B / FastVLM-class, chosen for fewer
  vision tokens)** event-triggered at 0.5–2fps — *not* every frame. Resident + warmed at launch.
- **Knowledge retrieval:** in-process FAISS/HNSW + small local embedder, results precomputed
  per (boss, phase, death-count) so the live path is a <1ms dict lookup. **Never run retrieval
  as a cloud HTTP service** — flagged as the single largest avoidable cost (50–600ms tail) for
  zero compute benefit on a small static per-game index.
- **Reactive reflex tips:** high-confidence template/OCR tell → precomputed/canned tip → local
  streaming TTS. No VLM, no network. The only sub-second tier, and it **must** be local.

**Run on Claude (cloud, fast tier):**
- **Situational + strategic coaching:** Haiku 4.5 (escalate to Sonnet for low-time-pressure
  strategic tips), vision+text, streaming. Send tiny text GameState + freshest keyframe; cache
  the static system+KB prefix; fire **speculatively** on the coarse event signal; stream the
  first clause into TTS.

**Conditions that flip the decision:**
- **→ Pure cloud** if the reactive tier and always-on perception are cut from scope.
- **→ Pure local (coach included)** if the network is unreliable/cellular, or privacy/offline
  mandates frames never leave the device — accept weaker 2–7B reasoning + Max-only budget.
- **Local situational viable only when ALL hold:** M3/M4 **Max-class** silicon (Pro/base = ~4s
  prefill *alone* for ~1500 tokens), adequate sustained cooling (desktop/16-inch, not a
  throttling 14-inch/Air), coach VLM **not** contending with perception VLM, and 2–7B coaching
  quality acceptable for the title.
- **Cloud loses the tail to local only under pathological network** (provider outage / congested
  cellular adding ~6000ms+) — an availability/SLA concern, not steady-state.

---

## 5. Hardest Irreducible Limits (cannot be engineered away)

1. **Capture-card frame age (40–210ms, both arches).** Can't pre-warm a frame the console
   hasn't drawn. Caps the reactive tier; negligible for the 1–4s situational tier.
2. **Cumulative frame staleness through delivery + sampling (~150–300ms pre-inference).**
   Architecture-independent.
3. **N-of-M temporal confirmation window (200–800ms, by design).** Suppresses false triggers;
   the wait *is* the start signal for everything downstream. Alone exceeds the <300ms twitch
   budget before inference/TTS start.
4. **Single-SoC contention + thermals.** One memory bus shared by perception VLM + OCR + (if
   local) coach VLM + local TTS; laptops throttle within minutes. The structural reason to
   offload heavy reasoning to cloud.
5. **Bluetooth audio transit (~130ms p50, ~220ms cold, terminal).** Nothing overlaps the last
   stage. Cold-start A2DP spike lands on the *first tip after a quiet stretch* — exactly the
   boss-entry/death moment. Bluetooth alone makes the <300ms reactive tier infeasible.

---

## 6. Concrete Recommendations

**Capture hardware (highest-leverage decision after model placement):**
- Low-latency external USB3.1+ card (**Elgato HD60 X / Cam Link 4K / 4K60-class**). Avoid
  MS2109-class MJPEG dongles (~200ms) and $6 dongles (~1s) — swings capture 150ms+.
- Capture **native uncompressed YUY2/NV12** (no in-card MJPEG round-trip), enable explicit
  **low-latency mode**, capture **1080p60 not 4K** (4K MJPEG decode ~8ms vs ~2ms,
  single-threaded; 60fps halves per-frame age vs 30fps).
- Time-stamp every frame at host-receive, propagate frame-age into the event engine, and **drop
  stale twitch tips** rather than react to a 100–200ms-stale event.

**Model choices:**
- **Situational/strategic → Claude Haiku 4.5** (Sonnet only for strategic/no-time-pressure).
  Bound `max_tokens` to 1–2 sentences so decode stays cheap and prefill dominates.
- **Perception → small light-encoder VLM** (FastVLM / Moondream-2B), event-triggered 0.5–2fps;
  OCR/template every frame.
- **Reactive → no model:** precomputed/canned micro-tips keyed by (boss, phase, event).

**On-device stack:**
- Co-locate retrieval **in-process** (FAISS/HNSW flat search for <10k chunks — exact, sub-ms —
  + small MLX/CoreML embedder). Spoiler filter as a **metadata pre-filter at index-build time**;
  hot-path spoiler re-check as a **precomputed keyword/trie blocklist (~0.5–2ms), never an
  embedding or LLM-judge pass**.
- **Wired/built-in audio as a product requirement** for the reactive tier (~130ms BT → ~6–10ms
  wired). If BT unavoidable: keep link hot with silent audio, prefer 2.4GHz dongle/aptX-LL,
  down-tier reactive→situational when a BT headset is detected.
- Prefer **Mac mini/Studio** for the perception host to remove the thermal variable; on a
  laptop, expect throttling and validate p95 under 30–120 min sustained load.

**What to pre-warm (at session launch, behind the game's load screen):**
- VLM weights + Metal/ANE graph JIT + one dummy inference (clears ~21.7s cold start).
- TTS model + one dummy synthesis (clears ~2.1s warmup).
- Embedding model + mmap'd vector index (clears 0.5–3s cold load).
- The Claude HTTP/2 connection (warm-pooled, keepalive) + the prompt-cache static prefix.
- The AVCaptureSession (never start/stop per tip) + a depth-1 latest-frame-wins ring buffer
  (`alwaysDiscardsLateVideoFrames=true`).

**Where to parallelize:**
- Capture/delivery on a dedicated high-QoS serial queue, decoupled from OCR/VLM workers, so a
  slow inference tick never back-pressures frame delivery.
- GameState assembly **non-blocking** — never barrier-wait on the VLM; merge VLM fields async
  with a freshness tag.
- **Speculatively fire** retrieval + the Claude call on the coarse event signal so server
  prefill overlaps the confirmation window; cancel on failed confirmation.
- **Stream the first clause** of coach output into TTS so synthesis runs concurrently with decode.
- Pin the event engine to a real-time/time-constraint thread (`mach_wait_until`) so wakeups stay
  <600µs instead of inheriting 500–5000µs default-QoS jitter under VLM contention.

**Where the optimistic plan was wrong:** it under-priced the floor at almost every
hardware-bound stage — 25ms capture floor (it's 40ms; a PCIe figure on a USB-only platform),
10ms USB-decode floor (below one 60Hz frame), 180ms perception floor and 2.2s local-coach p50
(both ~1.3–2x optimistic; corrected local coach is **4.2s p50 / 9s p95**), 45ms TTS floor
(model-inference-only, not first-*playable*-audio), and a 220ms playback p95 ignoring the
Bluetooth jitter/cold-start tail. The qualitative physics and mitigations were sound; the
absolute low-end numbers were best-case-hardware targets, not baselines.
