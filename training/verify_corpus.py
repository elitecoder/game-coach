"""Check downloaded corpus videos against corpus-manifest.json.

sha256 match = byte-identical to the file the labels were built from. A sha mismatch with matching
duration/resolution usually means the same stream re-muxed by a different yt-dlp/ffmpeg; the labels
(1 fps timestamps) still line up. A duration mismatch means the labels are not trustworthy for it.
"""
import hashlib, json, os, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
corpus = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "corpus")
bad = 0
for v in json.load(open(os.path.join(here, "corpus-manifest.json")))["videos"]:
    f = os.path.join(corpus, v["id"] + ".mp4")
    if not os.path.exists(f):
        print(f"MISSING   {v['id']}  (yt-dlp -f {v['youtube_format']} {v['url']})"); bad += 1; continue
    p = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height:format=duration", "-of", "json", f], capture_output=True, text=True).stdout)
    dur, h = float(p["format"]["duration"]), p["streams"][0]["height"]
    sha = hashlib.sha256()
    with open(f, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""): sha.update(b)
    if sha.hexdigest() == v["sha256"]: status = "IDENTICAL"
    elif abs(dur - v["duration_sec"]) < 0.5 and h == v["height"]: status = "SAME-STREAM"
    else: status = "DIFFERENT"; bad += 1
    print(f"{status:11} {v['id']}  {dur:.1f}s {h}p")
sys.exit(1 if bad else 0)
