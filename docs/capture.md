# Capture daemon

Foundation for the game-coach capture path: an ffmpeg segment-ring with a canonical capture-seconds
timeline, a frame/clip service, capture-health, and a **retain-until-analyzed** retention janitor.
Design lives in `docs/design.md` (§5.1, §6, contracts C2/C4/C5).

Runs **today with no hardware** (test pattern or a local video file), and against a real USB capture
card when it arrives — same code path.

---

## 1. What to buy

**Console for P1a: Nintendo Switch** (Hollow Knight + Silksong live here, and docked Switch outputs
HDMI with **no HDCP on gameplay** → capture is trivial; no workarounds).

Recommended kit (~$40, fully UVC, lag-free play):

| Item | ~Price | Notes |
|---|---|---|
| **MS2130-based USB 3.0 HDMI capture dongle** | ~$25 | True **UVC** (no drivers, works with ffmpeg/AVFoundation out of the box), 1080p60. Search "MS2130 USB 3.0 capture 1080p60". **Avoid MS2109** dongles — 1080p30 only, laggy. |
| **1-in / 2-out HDMI splitter** | ~$12 | Switch → splitter → TV (lag-free play) + capture dongle → Mac. |
| **HDMI cable** (+ USB-C adapter if needed) | ~$8 | Apple-Silicon Mac is USB-C; get a USB-C dongle or adapter. |

Nicer alternative (~$150–180): **Elgato HD60 X** (built-in passthrough, no splitter needed) or **Cam
Link 4K**. Verify UVC mode. For P1a the MS2130 + splitter is genuinely all you need.

**If you later capture Silksong on PS5:** PS5 enforces HDCP. Either disable it (Settings → System →
HDMI → **turn off Enable HDCP** — legitimate, lets cards record gameplay) or use an HDCP-stripping
splitter. The Switch needs none of this.

---

## 2. Setup (macOS, Apple Silicon)

Prereqs: Node 22+, `ffmpeg`. Install deps once:

```sh
npm install
```

With hardware:

1. Plug the capture dongle into the Mac. Wire: Switch (docked) → [splitter →] dongle → Mac.
2. **Grant Camera permission** — System Settings → Privacy & Security → **Camera** → enable for your
   terminal/IDE. A capture card enumerates as a camera; without this the feed is black/blocked.
3. Find the device index:
   ```sh
   npx tsx src/cli.ts list-devices       # note the [N] next to your capture device
   ```
4. Start capture + retention:
   ```sh
   npx tsx src/cli.ts start --source=device:0
   ```
5. In another terminal, pull from the buffer:
   ```sh
   npx tsx src/cli.ts status
   npx tsx src/cli.ts get-frame 12 --width=512 --out=/tmp/f.jpg
   ```

---

## 3. Run NOW without hardware

```sh
# synthetic test pattern
npx tsx src/cli.ts start --source=test

# OR loop a real gameplay clip (download a HK/Silksong video) — best for dogfooding the pipeline
npx tsx src/cli.ts start --source=file:/path/to/gameplay.mp4
```

Then, in another terminal:

```sh
npx tsx src/cli.ts status                          # capture-health + buffer span
npx tsx src/cli.ts get-frame 8 --width=2576 --out=/tmp/hi.jpg   # Opus hi-res single frame
npx tsx src/cli.ts clip 6 14 --out=/tmp/clip.ts                 # cut a clip [6s,14s]
npx tsx src/cli.ts watermark progression 10        # a consumer reports it analyzed up to t=10s
npx tsx src/cli.ts gc                              # run the retention janitor once
```

---

## 4. Retention model (retain-until-analyzed)

The ring is **not** a clock-based buffer that overwrites old media. A segment is reclaimable only
once it is **at or below every registered consumer's analyzed-watermark** AND older than the
live-coaching window (`liveWindowSeconds`, default 15 min). With **no consumer registered, nothing
is reclaimed** — we never drop media that hasn't been analyzed for progression (plan §5.1).

What persists long-term is the **derived progression ledger**, not the pixels: once the extraction
pass has watermarked past a span, the raw media is reclaimable. Disk safety valve: the janitor
reports usage + an over-ceiling flag but never blind-deletes un-analyzed media — the intended
response is to force/accelerate extraction or transcode to a low-bitrate analysis proxy (TODO hooks).

---

## 5. Module map (→ plan contracts)

| File | Responsibility | Contract |
|---|---|---|
| `src/capture.ts` | ffmpeg argv + spawn; mpegts ring (crash-survivable), hw h264 encode | §5.1 |
| `src/timeline.ts` | read the segment_list CSV → canonical capture-seconds index; `t → segment` | **C2** |
| `src/frames.ts` | `getFrame(t, res)` + `cutClip(t0,t1)` → Files-ready JPEG/clip | **C5** |
| `src/health.ts` | signal-present / buffer span / staleness — honest, never a black frame | **C4** |
| `src/retention.ts` | consumer-watermark janitor; retain-until-analyzed + disk valve | §5.1 |
| `src/daemon.ts` | wires capture + janitor loop | §5.1 |
| `src/cli.ts` | dev CLI over all of the above | — |

## 6. Known TODOs (foundation, not production)

- **Swift migration:** production daemon is macOS-native (AVFoundation, IOKit HID button bus). This
  TS scaffold proves the stream path and is the dogfood harness; the button bus + voice loop are not
  here yet.
- **CSV compaction:** ffmpeg owns the append-only segment CSV; reclaimed rows are tolerated (reads
  resolve missing files to a clean "reclaimed" reason) but not pruned.
- **Disk-valve actions** (force-extract / proxy-transcode) are flagged, not implemented.
- **Device modes:** `device:` capture lets avfoundation negotiate native mode; per-card
  `-video_size/-framerate` overrides to add once a real card is in hand.
- **HDCP/permission detection:** inferred from capture stalling, not parsed from ffmpeg stderr yet.
