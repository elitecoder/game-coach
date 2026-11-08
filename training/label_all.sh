#!/bin/bash
cd "$(dirname "$0")/.."
mkdir -p training/labels
PROF=perception/hud_profiles/hollow-knight.json
for V in training/corpus/*.mp4; do
  id=$(basename "$V" .mp4)
  [ -f "training/labels/$id.json" ] && continue
  echo "=== labeling $id ==="
  python3 perception/label_video.py "$V" "$PROF" > "training/labels/$id.json" 2>>training/label.err || echo "FAIL $id"
done
echo "=== AGGREGATE ==="
python3 - <<'PY'
import json, glob
tot=dict(videos=0, gp_min=0.0, damage=0, deaths=0)
for f in glob.glob("training/labels/*.json"):
    try: d=json.load(open(f))
    except: continue
    tot["videos"]+=1; tot["gp_min"]+=d["gameplay_frames"]/60
    tot["damage"]+=d["damage_events"]; tot["deaths"]+=d["deaths"]
print(json.dumps({"videos":tot["videos"], "gameplay_hours":round(tot["gp_min"]/60,1),
                  "total_damage_events":tot["damage"], "total_deaths":tot["deaths"]}, indent=2))
PY
echo "=== LABEL_ALL DONE ==="
