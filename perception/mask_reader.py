import sys, json, glob, re
import numpy as np
from PIL import Image

def hud_present(a, p):
    # Gate on the white swoosh above the soul vessel, not the vessel itself: an empty vessel is
    # dark, so the old vessel-brightness gate dropped every low-soul moment. Menus and the map
    # have no swoosh (inventory) or no masks (map), so both conditions are required.
    if a.mean() < p["black_luma_max"]:
        return False, "black"
    H, W = a.shape
    sw = a[int(p["swoosh_y"][0]*H):int(p["swoosh_y"][1]*H), int(p["swoosh_x"][0]*W):int(p["swoosh_x"][1]*W)]
    frac = (sw > p["bright_thresh"]).mean()
    # A bright background behind the mask row (White Palace, white-outs, the console home screen)
    # makes the mask threshold count garbage.
    roi = a[int(p["roi_y"][0]*H):int(p["roi_y"][1]*H), int(p["roi_x"][0]*W):int(p["roi_x"][1]*W)]
    if (roi > p["bright_thresh"]).mean() > p["roi_max_bright_frac"] or np.percentile(roi, 25) > p["roi_max_p25"]:
        return False, "bright background"
    return (frac >= p["swoosh_min_frac"] and count_masks(a, p) >= 1), f"swoosh={frac:.2f}"

def count_masks(a, p):
    H, W = a.shape
    roi = a[int(p["roi_y"][0]*H):int(p["roi_y"][1]*H), int(p["roi_x"][0]*W):int(p["roi_x"][1]*W)]
    min_col = max(3, int(p["min_col_frac"] * roi.shape[0]))
    min_run = max(4, int(p["min_run_frac"] * W))
    on = (roi > p["bright_thresh"]).sum(axis=0) > min_col
    masks, run, prev = 0, 0, False
    for v in on:
        if v and not prev: run = 1
        elif v: run += 1
        elif prev and run >= min_run: masks += 1
        prev = v
    if prev and run >= min_run: masks += 1
    return masks

def read(path, p):
    a = np.asarray(Image.open(path).convert("L"))
    ok, why = hud_present(a, p)
    return (count_masks(a, p) if ok else -1), why

if __name__ == "__main__":
    p = json.load(open(sys.argv[1]))
    for path in sorted(glob.glob(sys.argv[2]), key=lambda x:int(re.search(r't(\d+)',x).group(1))):
        t = int(re.search(r't(\d+)', path).group(1))
        m, why = read(path, p)
        print(f"t={t}  masks={m if m>=0 else 'NO-HUD'}   ({why})")
