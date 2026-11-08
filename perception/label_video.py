import sys, json, os, subprocess, tempfile, glob, re
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
from mask_reader import hud_present, count_masks

def label(video, prof, fps=1):
    p = json.load(open(prof))
    tmp = tempfile.mkdtemp(prefix="lbl_")
    subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-i",video,
                    "-vf",f"fps={fps}","-q:v","4",f"{tmp}/f%06d.jpg"], check=True)
    frames = sorted(glob.glob(f"{tmp}/f*.jpg"))
    series=[]
    for i,fp in enumerate(frames):
        a=np.asarray(Image.open(fp).convert("L"))
        ok,_=hud_present(a,p)
        series.append((i/fps, count_masks(a,p) if ok else -1))
    for fp in frames: os.remove(fp)
    os.rmdir(tmp)

    n=len(series); gp=[(t,m) for t,m in series if m>=0]
    gp_pct = round(100*len(gp)/max(1,n))
    hud_off = gp_pct < 35          # mostly no HUD -> teacher can't label; quarantine for student eval
    # median-smooth the gameplay mask series (window 3) to kill 1-frame flash/occlusion dips
    ms=[m for _,m in gp]
    sm=[int(np.median(ms[max(0,i-1):min(len(ms),i+2)])) for i in range(len(ms))]
    damage=[]; deaths=[]
    for i in range(1,len(sm)):
        if sm[i] < sm[i-1]: damage.append([round(gp[i][0],1), sm[i-1]-sm[i]])
        if sm[i]==0 and sm[i-1]>0: deaths.append(round(gp[i][0],1))
    return dict(dur_min=round(n/fps/60,1), frames=n, gameplay_frames=len(gp),
                gameplay_pct=gp_pct, hud_off=hud_off,
                damage_events=(0 if hud_off else len(damage)),
                deaths=(0 if hud_off else len(deaths)),
                sample_damage=damage[:6])

if __name__=="__main__":
    print(json.dumps(label(sys.argv[1], sys.argv[2]), indent=2))
