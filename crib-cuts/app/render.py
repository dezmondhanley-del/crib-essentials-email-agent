#!/usr/bin/env python3
"""
render.py — fill a template's slots with your own photos / clips and render the MP4.

python3 render.py templates/<name> --media clip1.mp4 photo2.jpg "clip3.mov@4.5" ... --out final.mp4

  • one media file per slot, in order (if you give fewer, they repeat)
  • "file@4.5" = start that clip 4.5 s in (pick the best moment)
  • photos get a slow push-in (turn off with --photo-motion none)
  • keeps the template's audio, cut timing and text overlays exactly
  • --texts edited.json  to swap the text (same format as template "texts")
"""
import argparse, json, os, subprocess, sys, tempfile, shutil
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.path.join(HERE, "fonts")
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".bmp"}


def run(cmd, stdin=None):
    r = subprocess.run(cmd, capture_output=True, input=stdin)
    if r.returncode != 0:
        sys.exit(f"command failed: {' '.join(map(str, cmd))}\n{r.stderr.decode()[-2500:]}")
    return r.stdout


def load_image(path):
    if path.lower().endswith(".heic"):
        tmp = path + ".conv.jpg"
        run(["ffmpeg", "-y", "-v", "error", "-i", path, tmp])
        path = tmp
    im = cv2.imread(path, cv2.IMREAD_COLOR)
    if im is None:
        im = cv2.cvtColor(np.array(Image.open(path).convert("RGB")), cv2.COLOR_RGB2BGR)
    return im


def cover(im, W, H, zoom=1.0, fx=0.5, fy=0.5):
    """Affine that scales image to cover W×H * zoom, centred on focus (fx, fy)."""
    h, w = im.shape[:2]
    s = max(W / w, H / h) * zoom
    tx = W / 2 - (fx * w) * s
    ty = H / 2 - (fy * h) * s
    # clamp so no black edges
    tx = min(0, max(W - w * s, tx))
    ty = min(0, max(H - h * s, ty))
    return np.float32([[s, 0, tx], [0, s, ty]])


def photo_segment(path, frames, W, H, fps, motion, out):
    im = load_image(path)
    proc = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
                             "-r", str(fps), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
                             "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
    for i in range(frames):
        p = i / max(1, frames - 1)
        z = 1.0 + 0.07 * p if motion == "zoom" else 1.0
        M = cover(im, W, H, z)
        fr = cv2.warpAffine(im, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
        proc.stdin.write(fr.tobytes())
    proc.stdin.close()
    proc.wait()


def video_segment(path, offset, frames, W, H, fps, out):
    vf = f"fps={fps},scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1,format=yuv420p"
    run(["ffmpeg", "-y", "-v", "error", "-stream_loop", "-1", "-ss", str(offset), "-i", path,
         "-vf", vf, "-frames:v", str(frames), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
         "-r", str(fps), out])


def font(name, px):
    p = os.path.join(FONT_DIR, name + ".ttf")
    if not os.path.exists(p):
        p = os.path.join(FONT_DIR, "tiktok-sans-700.ttf")
    return ImageFont.truetype(p, px)


def wrap(draw, text, fnt, max_w):
    out = []
    for para in text.split("\n"):
        words, cur = para.split(), ""
        for w in words:
            t = (cur + " " + w).strip()
            if draw.textlength(t, font=fnt) <= max_w or not cur:
                cur = t
            else:
                out.append(cur); cur = w
        out.append(cur)
    return out


def hex2rgb(h, default=(255, 255, 255)):
    if not h:
        return default
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def text_layer(t, W, H):
    fname = t.get("font", "tiktok-sans-700")
    px = int(t.get("font_px", 64))
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    explicit = t["text"].split("\n")
    if t.get("fit", True) and t.get("box_w"):
        # size the font so the widest line matches the original overlay's width
        widest = max(probe.textlength(l, font=font(fname, 100)) for l in explicit) or 1
        px = int(100 * t["box_w"] * W / widest)
        if t.get("box_h"):  # don't let a short line blow up taller than the original
            px = min(px, int(t["box_h"] * H / len(explicit) * 1.05))
        px = max(24, min(px, 160))
    fnt = font(fname, px)
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    max_w = int(W * 0.92)
    lines = wrap(d, t["text"], fnt, max_w)
    lh = int(t["box_h"] * H / len(explicit)) if t.get("box_h") else int(px * 1.22)
    lh = max(lh, int(px * 1.05))
    total_h = lh * len(lines)
    cx, cy = t["x"] * W, t["y"] * H
    y0 = cy - total_h / 2
    color = hex2rgb(t.get("color"))
    style = t.get("style", "shadow")
    stroke = max(2, int(px * t.get("stroke", 0.09)))

    if style == "shadow":
        sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        sd = ImageDraw.Draw(sh)
    align = t.get("align", "center")
    anc = {"center": "mm", "left": "lm", "right": "rm"}[align]
    ax = {"center": cx, "left": cx - max_w / 2, "right": cx + max_w / 2}[align]
    for i, ln in enumerate(lines):
        ly = y0 + i * lh + lh / 2
        if style == "box":
            x0, y0b, x1, y1b = d.textbbox((ax, ly), ln, font=fnt, anchor=anc)
            capt = d.textbbox((ax, ly), "Hg", font=fnt, anchor=anc)  # consistent pill height per line
            padx, pady = px * 0.32, px * 0.18
            d.rounded_rectangle([x0 - padx, capt[1] - pady, x1 + padx, capt[3] + pady], radius=int(px * 0.3),
                                fill=hex2rgb(t.get("bg"), (0, 0, 0)) + (255,))
            d.text((ax, ly), ln, font=fnt, fill=color + (255,), anchor=anc)
        elif style == "outline":
            d.text((ax, ly), ln, font=fnt, fill=color + (255,), anchor=anc, stroke_width=stroke, stroke_fill=(0, 0, 0, 255))
        else:
            sd.text((ax + px * 0.04, ly + px * 0.06), ln, font=fnt, fill=(0, 0, 0, 170), anchor=anc)
            d.text((ax, ly), ln, font=fnt, fill=color + (255,), anchor=anc)
    if style == "shadow":
        sh = sh.filter(ImageFilter.GaussianBlur(px * 0.08))
        sh.alpha_composite(layer)
        layer = sh
    return layer


def render_template(template_dir, media, out_path, texts_path=None, no_text=False, photo_motion="zoom", audio_path=None, texts=None):
    """media: list of paths (optionally "path@offset"). texts: list overriding template texts."""
    tdir = template_dir
    tpl = json.load(open(os.path.join(tdir, "template.json")))
    W, H, fps = tpl["width"], tpl["height"], tpl.get("fps", 30)
    slots = tpl["slots"]
    dur = tpl["duration"]
    work = tempfile.mkdtemp(prefix="render_")

    # exact frame counts so cuts land where the template's do (no drift)
    seg_files = []
    for i, s in enumerate(slots):
        spec = media[i % len(media)]
        path, off = (spec.rsplit("@", 1) + ["0"])[:2] if "@" in spec and os.path.exists(spec.rsplit("@", 1)[0]) else (spec, "0")
        f0 = round(s["start"] * fps)
        f1 = round((s["end"] if i < len(slots) - 1 else dur) * fps)
        n = max(1, f1 - f0)
        out = os.path.join(work, f"seg_{i:03d}.mp4")
        if os.path.splitext(path)[1].lower() in IMG_EXT:
            photo_segment(path, n, W, H, fps, photo_motion, out)
        else:
            video_segment(path, float(off), n, W, H, fps, out)
        seg_files.append(out)
        print(f"slot {i + 1:>2}: {os.path.basename(path)}  {n} frames")

    lst = os.path.join(work, "list.txt")
    with open(lst, "w") as f:
        f.writelines(f"file '{p}'\n" for p in seg_files)
    base = os.path.join(work, "base.mp4")
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", base])

    if texts is None:
        texts = [] if no_text else (json.load(open(texts_path)) if texts_path else tpl.get("texts", []))
    texts = [t for t in texts if not t.get("skip")]
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", base]
    audio = audio_path or (os.path.join(tdir, tpl["audio"]) if tpl.get("audio") else None)
    if audio:
        cmd += ["-i", audio]
    fc, last = [], "0:v"
    first_png = 2 if audio else 1
    for k, t in enumerate(texts):
        p = os.path.join(work, f"text_{k:02d}.png")
        text_layer(t, W, H).save(p)
        cmd += ["-i", p]
        lbl = f"v{k}"
        fc.append(f"[{last}][{first_png + k}:v]overlay=0:0:enable='between(t,{t['start']},{t['end']})'[{lbl}]")
        last = lbl
    if fc:
        cmd += ["-filter_complex", ";".join(fc), "-map", f"[{last}]"]
    else:
        cmd += ["-map", "0:v"]
    if audio:
        cmd += ["-map", "1:a", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-t", str(dur), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            "-r", str(fps), "-movflags", "+faststart", out_path]
    run(cmd)
    shutil.rmtree(work, ignore_errors=True)
    print(f"rendered -> {out_path}  ({dur}s, {len(slots)} cuts, {len(texts)} texts)")
    return out_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("template")
    ap.add_argument("--media", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--texts", help="json list replacing template texts")
    ap.add_argument("--no-text", action="store_true")
    ap.add_argument("--photo-motion", default="zoom", choices=["zoom", "none"])
    ap.add_argument("--audio", help="use a different audio file instead of the template's")
    a = ap.parse_args()

    render_template(a.template, a.media, a.out, a.texts, a.no_text, a.photo_motion, a.audio)

if __name__ == "__main__":
    main()
