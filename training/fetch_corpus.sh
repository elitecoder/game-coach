#!/bin/bash
# Fetch a curated, damage-rich Hollow Knight corpus (target 50h+) for training the
# event-perception model. Weighted toward real players TAKING DAMAGE (blind/first
# playthroughs) over no-hit boss runs, plus boss coverage for eval material.
set -u
CORPUS="$(cd "$(dirname "$0")" && pwd)/corpus"
mkdir -p "$CORPUS"
cd "$CORPUS" || exit 1

COMMON=(
  -f 'bv*[height<=480]+ba/b[height<=480]/b' --merge-output-format mp4
  --match-filter 'duration >= 900 & duration <= 50400'   # 15min .. 14h, skip shorts
  --download-archive archive.txt -o '%(id)s.%(ext)s'
  --no-playlist --ignore-errors --no-warnings --retries 5 --concurrent-fragments 4
)

# damage-rich first (new players get hit a lot), then hours, then boss coverage
QUERIES=(
  "ytsearch8:hollow knight first playthrough no commentary"
  "ytsearch8:hollow knight blind playthrough"
  "ytsearch5:hollow knight full playthrough no commentary"
  "ytsearch4:hollow knight longplay"
  "ytsearch5:hollow knight 112% walkthrough no commentary"
  "ytsearch8:hollow knight all bosses"
)

for q in "${QUERIES[@]}"; do
  echo "=== fetching: $q ==="
  yt-dlp "${COMMON[@]}" "$q" || echo "(query had errors, continuing)"
  # report accumulated hours so far
  HRS=$(for f in *.mp4; do [ -f "$f" ] && ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null; done | awk '{s+=$1} END{printf "%.1f", s/3600}')
  echo "=== corpus now ~${HRS}h across $(ls -1 *.mp4 2>/dev/null | wc -l | tr -d ' ') videos ==="
  # stop early once we comfortably exceed the target
  if awk "BEGIN{exit !(${HRS:-0} >= 55)}"; then echo "=== target reached (${HRS}h) ==="; break; fi
done
echo "=== FETCH COMPLETE ==="
