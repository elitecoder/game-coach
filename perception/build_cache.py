"""One decode pass per video -> teacher mask series + student inputs.

  <out>/<name>.masks.npy   int8 [N]           HUD mask count per step, -1 = no HUD (teacher)
  <out>/<name>.frames.npy  uint8 [N,90,160,3] student frames, HUD box zeroed
  <out>/<name>.mel.npy     float16 [M,64]     log-mel @ 100 Hz (absent if the source has no audio)
  <out>/<name>.meta.json

Steps are at FPS (4) from the start of the source. Usage:
  build_cache.py <hud_profile.json> <out_dir> <name>=<video_or_concat_list> [...]
A source ending in .txt is an ffmpeg concat list (used for the Switch capture ring).
--masks-only re-runs just the teacher into an existing cache (after a HUD-profile change) and
leaves frames and audio untouched.
"""
import json, os, subprocess, sys
from multiprocessing import Pool

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from mask_reader import count_masks, hud_present

FPS = 4
SW, SH = 160, 90
HUD_BOX = (0.45, 0.30)  # zero x<45%, y<30%: masks, soul vessel, geo counter
SR, HOP, NFFT, NMELS = 16000, 160, 400, 64


def ff_input(src):
    return ["-f", "concat", "-safe", "0", "-i", src] if src.endswith(".txt") else ["-i", src]


def probe(src):
    out = subprocess.run(["ffprobe", "-v", "error", *ff_input(src)[:-2], "-i", src, "-show_entries",
                          "stream=codec_type,width,height:format=duration", "-of", "json"],
                         capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    v = next(s for s in j["streams"] if s["codec_type"] == "video")
    has_audio = any(s["codec_type"] == "audio" for s in j["streams"])
    dur = j["format"].get("duration")
    if dur is None and src.endswith(".txt"):  # concat lists report no duration; 2 s capture segments
        dur = 2.1 * sum(1 for l in open(src) if l.startswith("file "))
    return v["width"], v["height"], float(dur), has_audio


def video_pass(name, src, prof, out, masks_only=False):
    w, h, dur, has_audio = probe(src)
    if h > 480:  # teacher thresholds are fractional; 480p is plenty and 4x cheaper than 1080p
        w, h = 854, 480
    n_alloc = int(dur * FPS) + 16
    frames = None if masks_only else np.lib.format.open_memmap(
        f"{out}/{name}.frames.tmp.npy", "w+", np.uint8, (n_alloc, SH, SW, 3))
    masks = np.full(n_alloc, -1, np.int8)
    hx, hy = int(HUD_BOX[0] * SW), int(HUD_BOX[1] * SH)
    proc = subprocess.Popen(["ffmpeg", "-v", "error", *ff_input(src), "-an", "-vf",
                             f"fps={FPS},scale={w}:{h},format=rgb24", "-f", "rawvideo", "-"],
                            stdout=subprocess.PIPE)
    size, n = w * h * 3, 0
    while n < n_alloc:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
        gray = np.asarray(Image.fromarray(rgb).convert("L"))
        ok, _ = hud_present(gray, prof)
        masks[n] = count_masks(gray, prof) if ok else -1
        n += 1
        if masks_only:
            continue
        small = np.asarray(Image.fromarray(rgb).resize((SW, SH), Image.BOX)).copy()
        small[:hy, :hx] = 0
        frames[n - 1] = small
    proc.stdout.close()
    proc.wait()
    if masks_only:
        np.save(f"{out}/{name}.masks.npy", masks[:n])
        return n, dur, has_audio, (w, h)
    frames.flush()
    del frames
    # trim to the real frame count
    tmp = np.load(f"{out}/{name}.frames.tmp.npy", mmap_mode="r")
    final = np.lib.format.open_memmap(f"{out}/{name}.frames.npy", "w+", np.uint8, (n, SH, SW, 3))
    for i in range(0, n, 4096):
        final[i:i + 4096] = tmp[i:min(i + 4096, n)]
    final.flush()
    del final, tmp
    os.remove(f"{out}/{name}.frames.tmp.npy")
    np.save(f"{out}/{name}.masks.npy", masks[:n])
    return n, dur, has_audio, (w, h)


def audio_pass(name, src, out):
    import torch, torchaudio

    mel = torchaudio.transforms.MelSpectrogram(SR, n_fft=NFFT, hop_length=HOP, n_mels=NMELS, center=False)
    proc = subprocess.Popen(["ffmpeg", "-v", "error", *ff_input(src), "-vn", "-ac", "1", "-ar", str(SR),
                             "-f", "f32le", "-"], stdout=subprocess.PIPE)
    chunk = SR * 60  # 60 s; carry NFFT-HOP samples so frames tile exactly across chunks
    carry, parts = np.zeros(0, np.float32), []
    while True:
        buf = proc.stdout.read(chunk * 4)
        if not buf:
            break
        x = np.concatenate([carry, np.frombuffer(buf, np.float32)])
        nfr = (len(x) - NFFT) // HOP + 1
        if nfr <= 0:
            carry = x
            continue
        m = mel(torch.from_numpy(x[: (nfr - 1) * HOP + NFFT].copy()))
        parts.append(torch.log(m + 1e-6).T.numpy().astype(np.float16))
        carry = x[nfr * HOP:]
    proc.wait()
    np.save(f"{out}/{name}.mel.npy", np.concatenate(parts) if parts else np.zeros((0, NMELS), np.float16))


def build(job):
    try:
        return _build(job)
    except Exception as e:  # one bad source must not take down the pool
        return job[0], f"FAILED {type(e).__name__}: {e}"


def _build(job):
    name, src, prof_path, out, masks_only = job
    prof = json.load(open(prof_path))
    if masks_only:
        meta = json.load(open(f"{out}/{name}.meta.json"))
        n = video_pass(name, src, prof, out, masks_only=True)[0]
        if n != meta["steps"]:
            return name, f"FAILED step count {n} != cached {meta['steps']}"
        before, meta["hud_steps"] = meta["hud_steps"], int((np.load(f"{out}/{name}.masks.npy") >= 0).sum())
        json.dump(meta, open(f"{out}/{name}.meta.json", "w"), indent=1)
        return name, f"hud steps {before} -> {meta['hud_steps']} of {n}"
    if os.path.exists(f"{out}/{name}.meta.json"):
        return name, "cached"
    n, dur, has_audio, wh = video_pass(name, src, prof, out)
    if has_audio:
        audio_pass(name, src, out)
    masks = np.load(f"{out}/{name}.masks.npy")
    meta = dict(name=name, source=src, fps=FPS, steps=n, duration=dur, has_audio=has_audio,
                teacher_res=wh, hud_steps=int((masks >= 0).sum()))
    json.dump(meta, open(f"{out}/{name}.meta.json", "w"), indent=1)
    return name, f"{n} steps, hud {meta['hud_steps']}, audio={has_audio}"


if __name__ == "__main__":
    masks_only = "--masks-only" in sys.argv
    prof, out, *pairs = [a for a in sys.argv[1:] if a != "--masks-only"]
    os.makedirs(out, exist_ok=True)
    jobs = [(p.split("=", 1)[0], p.split("=", 1)[1], prof, out, masks_only) for p in pairs]
    with Pool(min(len(jobs), max(1, os.cpu_count() - 2))) as pool:
        for name, msg in pool.imap_unordered(build, jobs):
            print(f"{name}: {msg}", flush=True)
