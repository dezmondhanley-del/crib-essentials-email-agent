#!/usr/bin/env python3
"""
extract_template.py — turn a Reel / TikTok (video or photo-slideshow) into a reusable template.

Video:      python3 extract_template.py --video in.mp4 --name my_template --out templates/
Slideshow:  python3 extract_template.py --images s1.jpg s2.jpg ... --audio sound.m4a --name x --out templates/
            (slide timing comes from --slide-dur, or from the audio's beats with --beats)

Writes templates/<name>/template.json, audio.m4a, thumbs/slot_XX.jpg, contact.jpg (review sheet)
"""
import argparse, json, os, subprocess, sys, re, difflib, shutil
import numpy as np
import cv2

W, H = 1080, 1920


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd)}\n{r.stderr[-2000:]}")
    return r.stdout


def probe(path):
    out = json.loads(run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]))
    v = next((s for s in out["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in out["streams"] if s["codec_type"] == "audio"), None)
    dur = float(out["format"].get("duration", 0))
    fps = 30.0
    if v and v.get("avg_frame_rate", "0/0") != "0/0":
        n, d = v["avg_frame_rate"].split("/")
        fps = float(n) / float(d) if float(d) else 30.0
    return dict(duration=dur, fps=fps, has_audio=a is not None,
                w=int(v["width"]) if v else 0, h=int(v["height"]) if v else 0)


# ---------------------------------------------------------------- cuts
def detect_cuts(path, threshold, min_len):
    from scenedetect import open_video, SceneManager
    from scenedetect.detectors import ContentDetector, AdaptiveDetector
    vid = open_video(path)
    sm = SceneManager()
    fps = vid.frame_rate
    sm.add_detector(AdaptiveDetector(adaptive_threshold=threshold, min_scene_len=max(2, int(min_len * fps))))
    sm.detect_scenes(vid)
    scenes = sm.get_scene_list()
    return [(s[0].seconds, s[1].seconds) for s in scenes]


def motion_score(path, start, end):
    """0 = still frame (photo-like), higher = moving footage."""
    cap = cv2.VideoCapture(path)
    ts = np.linspace(start + 0.05, max(start + 0.06, end - 0.05), 6)
    prev, diffs = None, []
    for t in ts:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, f = cap.read()
        if not ok:
            continue
        g = cv2.cvtColor(cv2.resize(f, (180, 320)), cv2.COLOR_BGR2GRAY).astype(np.float32)
        if prev is not None:
            diffs.append(float(np.mean(np.abs(g - prev))))
        prev = g
    cap.release()
    return round(float(np.mean(diffs)) if diffs else 0.0, 2)


# ---------------------------------------------------------------- OCR
_ENG = None
def _engine():
    global _ENG
    if _ENG is None:
        from rapidocr_onnxruntime import RapidOCR
        _ENG = RapidOCR()
    return _ENG


def ocr_frame(frame):
    """Return text lines: {text, box:[x,y,w,h] in 1080x1920 space, conf 0-100}."""
    img = cv2.resize(frame, (720, 1280))
    res, _ = _engine()(img)
    k = W / 720
    out = []
    for quad, text, conf in (res or []):
        text = text.strip()
        if conf < 0.6 or len(text) < 2 or not re.search(r"[A-Za-z0-9]", text):
            continue
        xs = [p[0] * k for p in quad]; ys = [p[1] * k for p in quad]
        x, y = min(xs), min(ys)
        w, h = max(xs) - x, max(ys) - y
        if h < 24:  # tiny UI text / watermarks
            continue
        out.append(dict(text=text, box=[int(x), int(y), int(w), int(h)], conf=float(conf) * 100, dark=False))
    return out


def merge_lines_into_blocks(lines):
    """Stack lines that sit directly on top of each other into one text block."""
    lines = sorted(lines, key=lambda l: l["box"][1])
    blocks = []
    for l in lines:
        x, y, w, h = l["box"]
        for b in blocks:
            bx, by, bw, bh = b["box"]
            lh = b["line_h"]
            cx, bcx = x + w / 2, bx + bw / 2
            if -lh * 0.2 <= y - (by + bh) < lh * 0.9 and abs(cx - bcx) < max(bw, w) * 0.6 and abs(h - lh) < lh * 0.5:
                b["lines"].append(l["text"])
                nx0, ny0 = min(bx, x), min(by, y)
                b["box"] = [nx0, ny0, max(bx + bw, x + w) - nx0, max(by + bh, y + h) - ny0]
                b["conf"] = min(b["conf"], l["conf"])
                break
        else:
            blocks.append(dict(lines=[l["text"]], box=list(l["box"]), line_h=h, conf=l["conf"]))
    for b in blocks:
        b["text"] = "\n".join(b["lines"])
    return blocks


def estimate_style(frame, box, dark=None):
    img = cv2.resize(frame, (W, H))
    x, y, w, h = [int(v) for v in box]
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    crop = img[y0:y1, x0:x1].reshape(-1, 3).astype(np.float32)
    pad = 6
    rx0, ry0, rx1, ry1 = max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad)
    ring = np.concatenate([img[ry0:ry0 + 3, rx0:rx1].reshape(-1, 3), img[ry1 - 3:ry1, rx0:rx1].reshape(-1, 3),
                           img[ry0:ry1, rx0:rx0 + 3].reshape(-1, 3), img[ry0:ry1, rx1 - 3:rx1].reshape(-1, 3)]).astype(np.float32)
    bg = np.median(ring, axis=0)
    ring_std = float(ring.std(axis=0).mean())
    lum = crop.mean(axis=1)
    # 2 clusters by luminance; text = the cluster farthest from the surrounding colour
    thr = (np.percentile(lum, 10) + np.percentile(lum, 90)) / 2
    lo, hi = crop[lum < thr], crop[lum >= thr]
    cands = [c for c in (lo, hi) if len(c) > 10]
    tc = max(cands, key=lambda c: np.abs(np.median(c, axis=0) - bg).mean()) if cands else np.array([255, 255, 255.])
    tcol = np.median(tc, axis=0)
    to_hex = lambda c: "#%02x%02x%02x" % (int(c[2]), int(c[1]), int(c[0]))
    # a "box" = uniform pill behind the text that differs from what's around the pill
    o = max(30, h)
    ox0, oy0, ox1, oy1 = max(0, x0 - o), max(0, y0 - o), min(W, x1 + o), min(H, y1 + o)
    outer = np.concatenate([img[oy0:oy0 + 4, ox0:ox1].reshape(-1, 3), img[oy1 - 4:oy1, ox0:ox1].reshape(-1, 3)]).astype(np.float32)
    outer_diff = np.abs(np.median(outer, axis=0) - bg).mean() if len(outer) else 0
    style = "shadow"
    if ring_std < 14 and np.abs(bg - tcol).mean() > 60 and outer_diff > 25:
        style = "box"
    elif tcol.mean() > 170 and (lum < 50).mean() > 0.06:
        style = "outline"
    return dict(style=style, color=to_hex(tcol), bg=to_hex(bg) if style == "box" else None)


def ocr_video(path, duration, step):
    cap = cv2.VideoCapture(path)
    samples = []
    t = 0.0
    while t < duration:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, f = cap.read()
        if not ok:
            break
        blocks = merge_lines_into_blocks(ocr_frame(f))
        for b in blocks:
            b["style"] = estimate_style(f, b["box"])
        samples.append((t, blocks))
        t += step
    cap.release()
    # track blocks across time
    events = []
    for t, blocks in samples:
        for b in blocks:
            key = re.sub(r"\s+", " ", b["text"].lower())
            best = None
            for e in events:
                if e["last_t"] < t - step * 2.1:
                    continue
                sim = difflib.SequenceMatcher(None, key, e["key"]).ratio()
                cy, ecy = b["box"][1] + b["box"][3] / 2, e["box"][1] + e["box"][3] / 2
                if sim > 0.6 and abs(cy - ecy) < 120 and (best is None or sim > best[0]):
                    best = (sim, e)
            if best:
                e = best[1]
                e["last_t"] = t
                e["hits"] += 1
                e["variants"].append((b["conf"], b["text"]))
                if b["conf"] > e["conf"]:
                    e.update(conf=b["conf"], box=b["box"], style=b["style"], line_h=b["line_h"])
            else:
                events.append(dict(key=key, first_t=t, last_t=t, hits=1, box=b["box"], conf=b["conf"],
                                   style=b["style"], line_h=b["line_h"], variants=[(b["conf"], b["text"])]))
    out = []
    for e in events:
        if e["hits"] < 2 and e["conf"] < 85:
            continue  # one-off noise
        text = max(e["variants"], key=lambda v: (v[1].count(" "), v[0]))[1]
        x, y, w, h = e["box"]
        out.append(dict(
            text=text,
            start=round(e["first_t"], 2),
            end=round(min(duration, e["last_t"] + step), 2),
            x=round((x + w / 2) / W, 4), y=round((y + h / 2) / H, 4),  # centre, normalized
            box_w=round(w / W, 4), box_h=round(h / H, 4),
            font_px=int(e["line_h"] * 1.15),
            align="center",
            font="tiktok-sans-700",
            **e["style"],
            conf=round(e["conf"], 1),
        ))
    out.sort(key=lambda d: d["start"])
    return out


# ---------------------------------------------------------------- beats (for slideshows)
def beat_times(audio_path):
    import librosa
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    return float(np.atleast_1d(tempo)[0]), librosa.frames_to_time(beats, sr=sr).tolist(), len(y) / sr


# ---------------------------------------------------------------- review sheet
def contact_sheet(thumbs, out):
    tiles = []
    for i, p in enumerate(thumbs):
        im = cv2.imread(p)
        im = cv2.resize(im, (216, 384))
        cv2.putText(im, str(i + 1), (8, 34), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 0, 0), 5)
        cv2.putText(im, str(i + 1), (8, 34), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 255, 255), 2)
        tiles.append(im)
    cols = min(6, len(tiles))
    rows = (len(tiles) + cols - 1) // cols
    sheet = np.full((rows * 384, cols * 216, 3), 30, np.uint8)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet[r * 384:(r + 1) * 384, c * 216:(c + 1) * 216] = t
    cv2.imwrite(out, sheet)


def extract_video(video, d, name, source="", threshold=3.0, min_len=0.25, ocr_step=0.25, ocr=True):
    """Build a template from a video file into folder d. Returns the template dict (also written to d/template.json)."""
    os.makedirs(os.path.join(d, "thumbs"), exist_ok=True)
    tpl = dict(name=name, source=source, width=W, height=H, fps=30, audio="audio.m4a", slots=[], texts=[])
    info = probe(video)
    tpl["duration"] = round(info["duration"], 3)
    if info["has_audio"]:
        run(["ffmpeg", "-y", "-v", "error", "-i", video, "-vn", "-c:a", "aac", "-b:a", "192k", os.path.join(d, "audio.m4a")])
    else:
        tpl["audio"] = None
    scenes = detect_cuts(video, threshold, min_len) or [(0.0, info["duration"])]
    scenes[-1] = (scenes[-1][0], info["duration"])
    thumbs = []
    cap = cv2.VideoCapture(video)
    for i, (s, e) in enumerate(scenes):
        cap.set(cv2.CAP_PROP_POS_MSEC, ((s + e) / 2) * 1000)
        ok, f = cap.read()
        tp = os.path.join(d, "thumbs", f"slot_{i + 1:02d}.jpg")
        if ok:
            cv2.imwrite(tp, cv2.resize(f, (540, 960)))
            thumbs.append(tp)
        m = motion_score(video, s, e)
        tpl["slots"].append(dict(slot=i + 1, start=round(s, 3), end=round(e, 3), dur=round(e - s, 3),
                                 kind="photo" if m < 1.5 else "video", motion=m, note=""))
    cap.release()
    if ocr:
        tpl["texts"] = ocr_video(video, info["duration"], ocr_step)
        # text changes almost always land on a cut: snap to the nearest one within one OCR step
        bounds = sorted({0.0, info["duration"]} | {s["start"] for s in tpl["slots"]})
        for t in tpl["texts"]:
            for k in ("start", "end"):
                near = min(bounds, key=lambda b: abs(b - t[k]))
                if abs(near - t[k]) <= ocr_step * 1.05:
                    t[k] = round(near, 3)
    contact_sheet(thumbs, os.path.join(d, "contact.jpg"))
    with open(os.path.join(d, "template.json"), "w") as f:
        json.dump(tpl, f, indent=2)
    return tpl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video")
    ap.add_argument("--images", nargs="*")
    ap.add_argument("--audio")
    ap.add_argument("--name", required=True)
    ap.add_argument("--out", default="templates")
    ap.add_argument("--source", default="")
    ap.add_argument("--threshold", type=float, default=3.0, help="cut sensitivity (lower = more cuts)")
    ap.add_argument("--min-len", type=float, default=0.25, help="shortest possible clip, seconds")
    ap.add_argument("--ocr-step", type=float, default=0.25)
    ap.add_argument("--no-ocr", action="store_true")
    ap.add_argument("--slide-dur", type=float, default=0, help="slideshow: fixed seconds per slide")
    ap.add_argument("--beats", type=int, default=0, help="slideshow: change slide every N beats")
    a = ap.parse_args()

    d = os.path.join(a.out, a.name)
    os.makedirs(os.path.join(d, "thumbs"), exist_ok=True)
    tpl = dict(name=a.name, source=a.source, width=W, height=H, fps=30, audio="audio.m4a", slots=[], texts=[])

    if a.video:
        tpl = extract_video(a.video, d, a.name, a.source, a.threshold, a.min_len, a.ocr_step, not a.no_ocr)
    elif a.images:
        if not a.audio:
            sys.exit("slideshow needs --audio")
        run(["ffmpeg", "-y", "-v", "error", "-i", a.audio, "-vn", "-c:a", "aac", "-b:a", "192k", os.path.join(d, "audio.m4a")])
        n = len(a.images)
        tempo, beats, adur = beat_times(a.audio)
        tpl["tempo"] = round(tempo, 1)
        if a.beats:
            marks = [0.0] + [beats[k] for k in range(a.beats, len(beats), a.beats)][: n - 1]
        else:
            sd = a.slide_dur or 2.0
            marks = [i * sd for i in range(n)]
            if beats:  # snap each change to nearest beat so it lands on the music
                marks = [0.0] + [min(beats, key=lambda b: abs(b - m)) for m in marks[1:]]
        ends = marks[1:] + [marks[-1] + (marks[-1] - marks[-2] if len(marks) > 1 else (a.slide_dur or 2.0))]
        tpl["duration"] = round(min(adur, ends[-1]), 3)
        thumbs = []
        for i, (s, e) in enumerate(zip(marks, ends)):
            tp = os.path.join(d, "thumbs", f"slot_{i + 1:02d}.jpg")
            im = cv2.imread(a.images[i])
            cv2.imwrite(tp, cv2.resize(im, (540, 960)))
            thumbs.append(tp)
            tpl["slots"].append(dict(slot=i + 1, start=round(s, 3), end=round(e, 3), dur=round(e - s, 3), kind="photo", note=""))
            if not a.no_ocr:
                for b in merge_lines_into_blocks(ocr_frame(im)):
                    x, y, w, h = b["box"]
                    tpl["texts"].append(dict(text=b["text"], start=round(s, 2), end=round(e, 2),
                                             x=round((x + w / 2) / W, 4), y=round((y + h / 2) / H, 4), box_w=round(w / W, 4), box_h=round(h / H, 4),
                                             font_px=int(b["line_h"] * 1.15), align="center", font="tiktok-sans-700",
                                             **estimate_style(im, b["box"]), conf=round(b["conf"], 1)))
        contact_sheet(thumbs, os.path.join(d, "contact.jpg"))
    else:
        sys.exit("give --video or --images")

    with open(os.path.join(d, "template.json"), "w") as f:
        json.dump(tpl, f, indent=2)
    print(f"template -> {d}/template.json")
    print(f"{len(tpl['slots'])} slots, {len(tpl['texts'])} text overlays, {tpl['duration']}s")
    for s in tpl["slots"]:
        print(f"  slot {s['slot']:>2}: {s['start']:6.2f}-{s['end']:6.2f}  ({s['dur']:.2f}s)  {s['kind']}")
    for t in tpl["texts"]:
        print(f"  text {t['start']:.2f}-{t['end']:.2f} [{t['style']}] {t['text']!r} conf={t['conf']}")


if __name__ == "__main__":
    main()
