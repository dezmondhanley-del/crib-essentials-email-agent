"""Claude calls: describe clips, clean up OCR'd text, match clips to template slots."""
import base64, json, re
import cv2
from . import config

_client = None


def client():
    global _client
    if _client is None:
        import anthropic
        _client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    return _client


def jpeg_b64(img_bgr, width=384):
    h, w = img_bgr.shape[:2]
    img = cv2.resize(img_bgr, (width, int(h * width / w)))
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return base64.b64encode(buf.tobytes()).decode()


def img_block(img_bgr, width=384):
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": jpeg_b64(img_bgr, width)}}


def ask_json(content, model=None, max_tokens=2000):
    r = client().messages.create(model=model or config.CLAUDE_MODEL, max_tokens=max_tokens,
                                 messages=[{"role": "user", "content": content}])
    text = "".join(b.text for b in r.content if getattr(b, "type", "") == "text")
    m = re.search(r"\{.*\}|\[.*\]", text, re.S)
    if not m:
        raise ValueError(f"no JSON in reply: {text[:300]}")
    return json.loads(m.group(0))


# ------------------------------------------------------------------ clips
def describe_clip(frames, duration, is_photo):
    """frames: list of BGR images sampled across the clip."""
    content = [img_block(f, 320) for f in frames]
    content.append({"type": "text", "text": (
        f"These are {len(frames)} frames from one {'photo' if is_photo else f'{duration:.1f}-second video clip'} "
        "in a home-decor brand's raw footage folder (Crib Essentials: handmade rugs, mirrors, wall art). "
        "Describe it for an editor who will match clips to shots in a reel. Reply with JSON only: "
        '{"shot":"selfie|talking-to-camera|wide-room|pan|close-up-product|hands-detail|pov-walk|outdoor|text-or-screen|other",'
        '"person_on_camera":true|false,"camera_motion":"static|slow|fast|handheld",'
        '"products":"short list of visible products or none","setting":"few words",'
        '"summary":"one sentence of what happens","quality":1-5}')})
    return ask_json(content, model=config.CLAUDE_FAST_MODEL, max_tokens=400)


# ------------------------------------------------------------------ template text
def clean_texts(texts, frames):
    """texts: OCR'd overlays; frames: frame (BGR) at each overlay's start. Returns cleaned list."""
    if not texts:
        return []
    content = []
    for i, (t, f) in enumerate(zip(texts, frames)):
        content.append({"type": "text", "text": f"Overlay {i}: OCR read {json.dumps(t['text'])} at x={t['x']:.2f}, y={t['y']:.2f}"})
        content.append(img_block(f, 540))
    content.append({"type": "text", "text": (
        "These are frames from a short-form video with OCR guesses of on-screen text. For each overlay decide: "
        "keep=true only if it is caption text the creator added in an editor (not a sign or object in the scene, "
        "not an @username, watermark, or app UI). Fix OCR mistakes, keep the creator's exact wording, capitalisation "
        "and line breaks (use \\n). Also match the look: font is one of "
        "tiktok-sans-cond-500 (narrow, Instagram 'Classic'/TikTok default look), tiktok-sans-700 (regular-width bold), "
        "montserrat-800 (wide geometric heavy), inter-700 (clean neutral); style is outline (black edge around letters), "
        "box (solid label behind text), or shadow (soft shadow / plain); stroke is outline thickness 0.03 (thin) to 0.1 (thick). "
        'Reply with JSON only: {"overlays":[{"i":0,"keep":true,"text":"...","font":"...","style":"outline","stroke":0.05,'
        '"color":"#ffffff","bg":null}]}')})
    res = ask_json(content, max_tokens=1500)
    fonts = {"tiktok-sans-cond-500", "tiktok-sans-700", "montserrat-800", "inter-700"}
    out = []
    for o in res.get("overlays", []):
        i = o.get("i")
        if isinstance(i, int) and 0 <= i < len(texts) and o.get("keep"):
            t = dict(texts[i])
            t["text"] = o.get("text") or t["text"]
            if o.get("font") in fonts:
                t["font"] = o["font"]
            if o.get("style") in ("outline", "box", "shadow"):
                t["style"] = o["style"]
            if isinstance(o.get("stroke"), (int, float)):
                t["stroke"] = max(0.02, min(0.12, float(o["stroke"])))
            if isinstance(o.get("color"), str) and o["color"].startswith("#"):
                t["color"] = o["color"]
            if t["style"] == "box" and isinstance(o.get("bg"), str):
                t["bg"] = o["bg"]
            out.append(t)
    return out


# ------------------------------------------------------------------ matching
def match_clips(slot_frames, slots, catalogue, avoid=()):
    """slot_frames: BGR frame per slot from the original reel. catalogue: list of clip docs.
    Returns {slot_number: clip_id}."""
    content = []
    for s, f in zip(slots, slot_frames):
        content.append({"type": "text", "text": f"Slot {s['slot']} — {s['dur']:.1f}s — original shot:"})
        content.append(img_block(f, 256))
    lines = []
    for c in catalogue:
        d = c.get("desc", {})
        lines.append(json.dumps({"id": c["_id"], "kind": c["kind"], "seconds": round(c.get("duration", 0), 1),
                                 "times_used": c.get("use_count", 0), "shot": d.get("shot"),
                                 "person": d.get("person_on_camera"), "motion": d.get("camera_motion"),
                                 "products": d.get("products"), "setting": d.get("setting"),
                                 "summary": d.get("summary"), "quality": d.get("quality")}))
    content.append({"type": "text", "text": (
        "You are the editor for Crib Essentials (handmade home decor). Fill each slot of this reel template with the "
        "clip from the library below that best matches the ORIGINAL shot's framing, action and energy "
        "(e.g. a selfie slot gets a talking-to-camera clip, a room-pan slot gets a pan). Rules: a video slot needs a "
        "video clip at least as long as the slot when possible; photos are fine for short or still slots; don't use "
        "the same clip twice in one reel unless the library is too small; prefer clips with lower times_used and "
        "higher quality." + (f" Try NOT to reuse these clip ids from the last attempt: {list(avoid)}." if avoid else "") +
        " Also write a short Instagram/TikTok caption for Crib Essentials in a casual founder voice with 3-5 relevant hashtags."
        "\n\nLibrary:\n" + "\n".join(lines) +
        '\n\nReply with JSON only: {"picks":[{"slot":1,"id":"<clip id>","why":"few words"}],"caption":"..."}')})
    res = ask_json(content, max_tokens=1500)
    ids = {c["_id"] for c in catalogue}
    picks = {int(p["slot"]): p["id"] for p in res.get("picks", []) if p.get("id") in ids}
    return picks, res.get("caption", "")
