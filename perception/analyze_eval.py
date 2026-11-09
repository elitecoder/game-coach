"""Post-eval checks on saved per-step scores (run after `student.py eval`).

  analyze_eval.py <cache_dir> <run_dir> <name> [...]

combat-AP: AP using only steps within 10 s of a teacher hit (hits vs. near-miss moments in the
same fight). A model that learned "combat is happening" instead of "the Knight was hit" scores
near chance here even if its overall AP is high.
"""
import os, sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import student as S

cache, run, *names = sys.argv[1:]
for name in names:
    src = S.Source(cache, name)
    near = np.zeros(len(src.y), bool)
    for h in src.hits:
        near[max(0, h - 40):h + 41] = True
    sel = near & (src.y >= 0)
    y = src.y[sel] == 1
    row = [f"{name:16} combat steps={sel.sum():6} pos rate={y.mean():.2f}"]
    for mode in ("fused", "video", "audio", "baseline"):
        p = f"{run}/scores_{name}_{mode}.npy"
        if os.path.exists(p):
            row.append(f"{mode}={S.average_precision(y, np.load(p)[sel]):.3f}")
    print("  ".join(row))
