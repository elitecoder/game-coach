"""HUD-free damage detector ("student"), distilled from the HUD mask teacher.

The teacher reads the health HUD; the student never sees it (HUD box is zeroed in its frames) and
must detect "the Knight just took damage" from the picture and game audio alone.

  student.py events <cache_dir>                         teacher events per video (+ summary)
  student.py train  <cache_dir> <run_dir> --val=a,b --test=c,d [--epochs=N]
  student.py eval   <cache_dir> <run_dir> <name> [...]  event-level P/R/F1 vs the teacher

Labels: a damage event is a drop in the smoothed mask count. The HUD redraws ~0-0.75 s after
contact, so the hit is placed one step before the drop. Steps within +-1 of a hit are positive,
+-2 are ignored, and other steps whose whole window has a readable HUD are negative.
"""
import json, os, sys, time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

FPS = 4
WIN_BEFORE, WIN_AFTER = 4, 3  # frames t-4 .. t+3 (2 s)
MEL_HZ = 100
MEL_LEN = (WIN_BEFORE + WIN_AFTER + 1) * MEL_HZ // FPS  # 200
MAX_DROP = 2  # larger drops are edits/cuts/save swaps in YouTube footage, not damage
GAP_FILL = 4  # bridge HUD read dropouts up to 1 s
PERSIST = 8  # a hit needs 2 s of readable HUD before and after
HAZARD_GAP = 16  # hazard respawn fade: up to 4 s of no HUD


# ---------- teacher -> events ----------

def smooth_series(m):
    """Forward-fill short HUD dropouts, then median-5 within each HUD-visible run."""
    m = m.astype(np.int16).copy()
    last, gap = -1, 0
    for i in range(len(m)):
        if m[i] >= 0:
            last, gap = m[i], 0
        elif last >= 0 and gap < GAP_FILL:
            m[i], gap = last, gap + 1
        else:
            last = -1
    out = np.full(len(m), -1, np.int16)
    i = 0
    while i < len(m):
        if m[i] < 0:
            i += 1
            continue
        j = i
        while j < len(m) and m[j] >= 0:
            j += 1
        seg = m[i:j]
        pad = np.pad(seg, 2, mode="edge")
        out[i:j] = np.median(np.lib.stride_tricks.sliding_window_view(pad, 5), axis=1).astype(np.int16)
        i = j
    return out


def teacher_events(masks):
    """Returns (hit_steps, ignore_steps, valid) where valid marks steps with a readable HUD."""
    s = smooth_series(masks)
    hits, ignore = [], []
    for i in range(1, len(s)):
        if s[i] >= 0 and s[i - 1] >= 0 and s[i] < s[i - 1]:
            # Real damage: the HUD stays readable for 2 s either side and the lower count holds.
            # HUD fade-outs (cutscenes, transitions) and YouTube edit cuts fail this.
            before, after = s[max(0, i - PERSIST):i], s[i:i + PERSIST]
            stable = len(before) == PERSIST and len(after) == PERSIST and (before >= 0).all() \
                and (after >= 0).all() and after.max() < s[i - 1]
            # If smoothing bridged a HUD dropout (hazard hits fade to black), the contact is just
            # before the dropout, not where the HUD comes back.
            j = i - 1
            while j > i - 1 - GAP_FILL and masks[j] < 0:
                j -= 1
            (hits if stable and s[i - 1] - s[i] <= MAX_DROP else ignore).append(j)
    # Hazard hits (spikes, acid, pits): the screen fades out for 1-4 s and the HUD comes back
    # 1-2 masks lower and stays there. Deaths come back full and room transitions unchanged.
    i = 0
    while i < len(s):
        if s[i] >= 0:
            i += 1
            continue
        j = i
        while j < len(s) and s[j] < 0:
            j += 1
        if j - i <= HAZARD_GAP and i >= PERSIST and j + PERSIST <= len(s):
            before, after = s[i - PERSIST:i], s[j:j + PERSIST]
            if (before >= 0).all() and (after >= 0).all() and (before == before[-1]).all() \
                    and (after == after[0]).all() and 1 <= before[-1] - after[0] <= MAX_DROP:
                k = i - 1  # smoothing forward-filled into the fade; the contact is before the raw dropout
                while k > i - 1 - GAP_FILL and masks[k] < 0:
                    k -= 1
                hits.append(k)
        i = j
    return np.array(sorted(hits), int), np.array(ignore, int), s >= 0


def step_labels(masks):
    """Per-step label: 1 pos, 0 neg, -1 ignore."""
    hits, ignore, valid = teacher_events(masks)
    n = len(masks)
    y = np.where(valid, 0, -1).astype(np.int8)
    # a negative needs the whole input window to be HUD-visible (otherwise the teacher can't vouch)
    vw = np.convolve(valid.astype(int), np.ones(WIN_BEFORE + WIN_AFTER + 1, int), "same")
    y[vw < WIN_BEFORE + WIN_AFTER + 1] = -1
    for h in ignore:
        y[max(0, h - 8):h + 9] = -1
    for h in hits:
        y[max(0, h - 2):h + 3] = np.where(y[max(0, h - 2):h + 3] == 1, 1, -1)
    for h in hits:
        y[max(0, h - 1):h + 2] = 1
    y[:WIN_BEFORE] = -1
    y[n - WIN_AFTER:] = -1
    return y, hits


def cmd_events(cache):
    rows = []
    for meta_path in sorted(f for f in os.listdir(cache) if f.endswith(".meta.json")):
        name = meta_path[:-10]
        m = np.load(f"{cache}/{name}.masks.npy")
        y, hits = step_labels(m)
        hours = (m >= 0).sum() / FPS / 3600
        rows.append((name, len(hits), int((y == 1).sum()), int((y == 0).sum()), round(hours, 2)))
        print(f"{name:20} hits={len(hits):5}  pos_steps={rows[-1][2]:6}  neg_steps={rows[-1][3]:7}  hud_h={hours:.2f}")
    print("total hits", sum(r[1] for r in rows), "hud hours", round(sum(r[4] for r in rows), 1))


# ---------- data ----------

class Source:
    def __init__(self, cache, name):
        self.name = name
        self.meta = json.load(open(f"{cache}/{name}.meta.json"))
        self.frames = np.load(f"{cache}/{name}.frames.npy", mmap_mode="r")
        self.mel = np.load(f"{cache}/{name}.mel.npy", mmap_mode="r") if self.meta["has_audio"] else None
        self.masks = np.load(f"{cache}/{name}.masks.npy")
        self.y, self.hits = step_labels(self.masks)

    def window(self, t):
        f = np.asarray(self.frames[t - WIN_BEFORE:t + WIN_AFTER + 1])  # [8,H,W,3]
        if self.mel is None:
            return f, np.zeros((MEL_LEN, 64), np.float16), 0.0
        a = (t - WIN_BEFORE) * MEL_HZ // FPS
        mel = np.asarray(self.mel[a:a + MEL_LEN])
        if len(mel) < MEL_LEN:
            return f, np.zeros((MEL_LEN, 64), np.float16), 0.0
        return f, mel, 1.0


def to_tensors(batch, device):
    import torch

    f = torch.from_numpy(np.stack([b[0] for b in batch])).to(device)  # [B,8,H,W,3] uint8
    f = f.permute(0, 1, 4, 2, 3).float() / 255.0  # [B,8,3,H,W]
    mel = torch.from_numpy(np.stack([b[1] for b in batch]).astype(np.float32)).to(device)
    has_a = torch.tensor([b[2] for b in batch], device=device)
    return f, mel, has_a


# ---------- model ----------

def build_model():
    import torch
    from torch import nn

    def block(i, o):
        return nn.Sequential(nn.Conv2d(i, o, 3, 2, 1), nn.BatchNorm2d(o), nn.ReLU(inplace=True),
                             nn.Conv2d(o, o, 3, 1, 1), nn.BatchNorm2d(o), nn.ReLU(inplace=True))

    class Student(nn.Module):
        def __init__(self):
            super().__init__()
            # per-frame encoder on [rgb, rgb - prev rgb]: motion/flash cues matter more than appearance
            self.frame = nn.Sequential(block(6, 32), block(32, 64), block(64, 96), block(96, 128),
                                       nn.AdaptiveAvgPool2d((2, 5)), nn.Flatten(), nn.Linear(128 * 10, 192))
            self.temporal = nn.Sequential(nn.Conv1d(192, 192, 3, 1, 1), nn.ReLU(inplace=True),
                                          nn.Conv1d(192, 192, 3, 1, 1), nn.ReLU(inplace=True))
            self.audio = nn.Sequential(block(1, 32), block(32, 64), block(64, 128),
                                       nn.AdaptiveAvgPool2d((1, 4)), nn.Flatten(), nn.Linear(128 * 4, 192))
            self.no_audio = nn.Parameter(torch.zeros(192))
            self.head = nn.Sequential(nn.Linear(384, 192), nn.ReLU(inplace=True), nn.Dropout(0.2), nn.Linear(192, 1))
            self.register_buffer("mel_mu", torch.tensor(0.0))
            self.register_buffer("mel_sd", torch.tensor(1.0))

        def forward(self, f, mel, has_audio, drop_audio=0.0, drop_video=0.0):
            B, T = f.shape[:2]
            prev = torch.cat([f[:, :1], f[:, :-1]], 1)
            x = torch.cat([f, f - prev], 2).flatten(0, 1)
            v = self.frame(x).view(B, T, -1).transpose(1, 2)
            v = self.temporal(v).amax(2)
            a = self.audio(((mel - self.mel_mu) / self.mel_sd).unsqueeze(1))
            use_a = has_audio.clone()
            if self.training and drop_audio > 0:
                use_a = use_a * (torch.rand(B, device=f.device) > drop_audio).float()
            a = torch.where(use_a[:, None] > 0, a, self.no_audio.expand(B, -1))
            if self.training and drop_video > 0:
                keep = (torch.rand(B, 1, device=f.device) > drop_video).float()
                v = v * keep
            return self.head(torch.cat([v, a], 1)).squeeze(1)

    return Student()


def device():
    import torch

    return torch.device("mps" if torch.backends.mps.is_available() else "cpu")


# ---------- train ----------

def cmd_train(cache, run, val, test, epochs=8, bs=48, neg_ratio=4, seed=0, max_steps=None):
    import torch
    from torch import nn

    os.makedirs(run, exist_ok=True)
    rng = np.random.default_rng(seed)
    names = sorted(f[:-10] for f in os.listdir(cache) if f.endswith(".meta.json"))
    held = set(val) | set(test)
    # HUD-off videos (<35% readable HUD, quarantined in June) give the teacher too little to vouch for
    hud_off = {n for n in names if (lambda m: m["hud_steps"] < 0.35 * m["steps"])(json.load(open(f"{cache}/{n}.meta.json")))}
    train_names = [n for n in names if n not in held | hud_off and not n.startswith(("fk_", "gruz"))]
    print("train:", train_names, "\nval:", val, "\ntest:", test, flush=True)
    srcs = {n: Source(cache, n) for n in train_names + list(val)}
    dev = device()
    model = build_model().to(dev)

    # audio normalisation from a sample of training mel frames
    mels = [s.mel[rng.integers(0, len(s.mel), 2000)] for n, s in srcs.items() if s.mel is not None and n in train_names]
    allm = np.concatenate(mels).astype(np.float32)
    model.mel_mu.fill_(float(allm.mean()))
    model.mel_sd.fill_(float(allm.std() + 1e-6))

    pos = [(n, t) for n in train_names for t in np.flatnonzero(srcs[n].y == 1)]
    neg = [(n, t) for n in train_names for t in np.flatnonzero(srcs[n].y == 0)]
    print(f"train pos steps {len(pos)}, neg steps {len(neg)}", flush=True)
    val_items = [(n, t) for n in val for t in np.flatnonzero(srcs[n].y >= 0)]
    val_items = [val_items[i] for i in rng.choice(len(val_items), min(12000, len(val_items)), replace=False)]

    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    steps_per_epoch = min((len(pos) * (1 + neg_ratio)) // bs, max_steps or 10**9)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 1e-3, total_steps=epochs * steps_per_epoch)
    lossf = nn.BCEWithLogitsLoss()
    log = []
    best = -1.0
    for ep in range(epochs):
        model.train()
        items = pos + [neg[i] for i in rng.choice(len(neg), len(pos) * neg_ratio, replace=False)]
        order = rng.permutation(len(items))
        t0, tot = time.time(), 0.0

        def load(k):
            idx = order[k * bs:(k + 1) * bs]
            return ([srcs[items[i][0]].window(items[i][1]) for i in idx],
                    [float(srcs[items[i][0]].y[items[i][1]]) for i in idx])

        pool = ThreadPoolExecutor(6)
        pending = [pool.submit(load, k) for k in range(min(8, steps_per_epoch))]
        for k in range(steps_per_epoch):
            batch, yl = pending.pop(0).result()
            if k + len(pending) + 1 < steps_per_epoch:
                pending.append(pool.submit(load, k + len(pending) + 1))
            ys = torch.tensor(yl, device=dev)
            f, mel, has_a = to_tensors(batch, dev)
            logit = model(f, mel, has_a, drop_audio=0.3, drop_video=0.1)
            loss = lossf(logit, ys)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += loss.item()
            if k % 200 == 0:
                print(f"ep {ep} step {k}/{steps_per_epoch} loss {tot / (k + 1):.4f} {time.time() - t0:.0f}s", flush=True)
        pool.shutdown()
        ap = step_ap(model, srcs, val_items, dev)
        log.append(dict(epoch=ep, loss=tot / steps_per_epoch, val_ap=ap, sec=time.time() - t0))
        print(f"== epoch {ep} loss {tot / steps_per_epoch:.4f} val step-AP fused={ap['fused']:.3f} "
              f"video={ap['video']:.3f} audio={ap['audio']:.3f}", flush=True)
        if ap["fused"] > best:
            best = ap["fused"]
            torch.save(model.state_dict(), f"{run}/best.pt")
        torch.save(model.state_dict(), f"{run}/last.pt")
        json.dump(dict(train=train_names, val=val, test=test, log=log), open(f"{run}/train_log.json", "w"), indent=1)


def average_precision(y, s):
    o = np.argsort(-s)
    y = y[o]
    tp = np.cumsum(y)
    prec = tp / np.arange(1, len(y) + 1)
    return float((prec * y).sum() / max(1, y.sum()))


def score_items(model, srcs, items, dev, mode="fused", bs=128):
    import torch

    model.eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(items), bs):
            batch = [srcs[n].window(t) for n, t in items[i:i + bs]]
            f, mel, has_a = to_tensors(batch, dev)
            if mode == "video":
                has_a = torch.zeros_like(has_a)
            if mode == "audio":
                f = torch.zeros_like(f)
            out.append(torch.sigmoid(model(f, mel, has_a)).float().cpu().numpy())
    return np.concatenate(out)


def step_ap(model, srcs, items, dev):
    y = np.array([srcs[n].y[t] for n, t in items]) == 1
    return {m: average_precision(y, score_items(model, srcs, items, dev, m)) for m in ("fused", "video", "audio")}


# ---------- event-level eval ----------

def peaks(score, thr, min_gap=4):
    idx = np.flatnonzero(score >= thr)
    picked = []
    for i in idx[np.argsort(-score[idx])]:
        if all(abs(i - p) >= min_gap for p in picked):
            picked.append(i)
    return np.array(sorted(picked), int)


def match(pred, truth, tol=4):
    used, tp = set(), 0
    for p in pred:
        c = [k for k, h in enumerate(truth) if abs(h - p) <= tol and k not in used]
        if c:
            used.add(min(c, key=lambda k: abs(truth[k] - p)))
            tp += 1
    return tp


def baseline_scores(src):
    """No-training baseline (June plan): screen-flash = jump in global luma vs the previous step,
    plus whole-frame motion. Max over the window, like the student's receptive field."""
    f = src.frames
    n = len(f)
    luma = np.array([f[i].mean() for i in range(n)], np.float32)
    diff = np.zeros(n, np.float32)
    for i in range(1, n):
        diff[i] = np.abs(f[i].astype(np.int16) - f[i - 1].astype(np.int16)).mean()
    flash = np.maximum(0, np.diff(luma, prepend=luma[0])) + 0.5 * diff
    s = np.zeros(n, np.float32)
    for t in range(WIN_BEFORE, n - WIN_AFTER):
        s[t] = flash[t - 1:t + 3].max()
    return s / (s.max() + 1e-6)


def cmd_eval(cache, run, names, thr=None):
    import torch

    dev = device()
    model = build_model().to(dev)
    model.load_state_dict(torch.load(f"{run}/best.pt", map_location=dev))
    cal = json.load(open(f"{run}/threshold.json")) if os.path.exists(f"{run}/threshold.json") else {}
    results = {}
    for name in names:
        src = Source(cache, name)
        n = len(src.masks)
        eval_mask = src.y >= 0  # only score where the teacher can vouch for the truth
        ts = list(range(WIN_BEFORE, n - WIN_AFTER))
        truth = src.hits
        res = dict(teacher_hits=int(len(truth)), hud_hours=round(eval_mask.sum() / FPS / 3600, 2),
                   has_audio=src.meta["has_audio"])
        modes = ["fused", "video", "audio"] if src.meta["has_audio"] else ["video"]
        for mode in modes + ["baseline"]:
            if mode == "baseline":
                s = baseline_scores(src)
            else:
                s = np.zeros(n, np.float32)
                s[ts] = score_items(model, {name: src}, [(name, t) for t in ts], dev, mode)
            s_eval = np.where(eval_mask, s, 0)
            y = src.y[eval_mask] == 1
            ap = average_precision(y, s[eval_mask])
            t_used = thr if thr is not None else cal.get(mode, 0.5)
            pred = peaks(s_eval, t_used)
            tp = match(pred, truth)
            p = tp / max(1, len(pred))
            r = tp / max(1, len(truth))
            res[mode] = dict(step_ap=round(ap, 3), thr=round(float(t_used), 3), pred=int(len(pred)), tp=tp,
                             precision=round(p, 3), recall=round(r, 3), f1=round(2 * p * r / max(1e-9, p + r), 3))
            np.save(f"{run}/scores_{name}_{mode}.npy", s)
        results[name] = res
        print(name, json.dumps(res), flush=True)
    return results


def cmd_calibrate(cache, run, val):
    """Pick per-mode event thresholds that maximise event F1 on the validation videos."""
    import torch

    dev = device()
    model = build_model().to(dev)
    model.load_state_dict(torch.load(f"{run}/best.pt", map_location=dev))
    srcs = [Source(cache, n) for n in val]
    best = {}
    for mode in ("fused", "video", "audio", "baseline"):
        per = []
        for src in srcs:
            n = len(src.masks)
            ts = list(range(WIN_BEFORE, n - WIN_AFTER))
            if mode == "baseline":
                s = baseline_scores(src)
            else:
                s = np.zeros(n, np.float32)
                s[ts] = score_items(model, {src.name: src}, [(src.name, t) for t in ts], dev, mode)
            per.append((np.where(src.y >= 0, s, 0), src.hits))
        cands = []
        for thr in np.r_[np.linspace(0.05, 0.95, 37), 0.96, 0.97, 0.98, 0.99, 0.995]:  # confident models peak high
            tp = npred = ntruth = 0
            for s, truth in per:
                pr = peaks(s, thr)
                tp += match(pr, truth)
                npred += len(pr)
                ntruth += len(truth)
            p, r = tp / max(1, npred), tp / max(1, ntruth)
            cands.append((2 * p * r / max(1e-9, p + r), float(thr)))
        best[mode] = max(cands)[1]
        print(mode, "thr", best[mode], "val event F1", round(max(cands)[0], 3), flush=True)
    json.dump(best, open(f"{run}/threshold.json", "w"), indent=1)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
    cmd = args[0]
    if cmd == "events":
        cmd_events(args[1])
    elif cmd == "train":
        cmd_train(args[1], args[2], opts["val"].split(","), opts["test"].split(","), int(opts.get("epochs", 8)),
                  max_steps=int(opts["max-steps"]) if "max-steps" in opts else None)
    elif cmd == "calibrate":
        cmd_calibrate(args[1], args[2], opts["val"].split(","))
    elif cmd == "eval":
        r = cmd_eval(args[1], args[2], args[3:], float(opts["thr"]) if "thr" in opts else None)
        json.dump(r, open(f"{args[2]}/eval_{opts.get('tag', 'run')}.json", "w"), indent=1)
