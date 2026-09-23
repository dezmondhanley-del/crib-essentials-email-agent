"""The automatic flow: shared link → template → pick clips → render → Drive → notify."""
import json, os, secrets, shutil, subprocess, datetime as dt
import cv2
from . import config, db, drive, llm, download, notify
from .extract_template import extract_video
from .render import render_template

IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic"}


def _probe_duration(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                             capture_output=True, text=True, timeout=60).stdout.strip()
        return float(out)
    except Exception:
        return 0.0


def _frames(path, n=3):
    ext = os.path.splitext(path)[1].lower()
    if ext in IMG_EXT:
        im = cv2.imread(path)
        if im is None and ext == ".heic":
            tmp = path + ".jpg"
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", path, tmp])
            im = cv2.imread(tmp)
        return [im] if im is not None else []
    cap = cv2.VideoCapture(path)
    dur = _probe_duration(path) or 1
    out = []
    for k in range(n):
        cap.set(cv2.CAP_PROP_POS_MSEC, (k + 0.5) / n * dur * 1000)
        ok, f = cap.read()
        if ok:
            out.append(f)
    cap.release()
    return out


def _ext_for(name, mime):
    ext = os.path.splitext(name)[1].lower()
    if ext:
        return ext
    return ".jpg" if mime.startswith("image/") else ".mp4"


def clip_path(clip):
    d = os.path.join(config.WORK_DIR, "clips")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, clip["_id"] + clip.get("ext", ".mp4"))
    if not os.path.exists(p) or os.path.getsize(p) == 0:
        drive.download(clip["_id"], p)
    return p


# ------------------------------------------------------------------ Raw Clips catalogue
def scan_clips():
    """Describe any new clip in the Raw Clips folder once (Claude looks at 3 frames) and remember it."""
    if not config.RAW_CLIPS_FOLDER_ID:
        return 0
    files = drive.list_media(config.RAW_CLIPS_FOLDER_ID)
    seen = {f["id"] for f in files}
    db.clips.update_many({"_id": {"$nin": list(seen)}, "deleted": {"$ne": True}}, {"$set": {"deleted": True}})
    new = 0
    for f in files:
        if db.clips.find_one({"_id": f["id"], "deleted": {"$ne": True}}):
            continue
        ext = _ext_for(f["name"], f["mimeType"])
        doc = {"_id": f["id"], "name": f["name"], "ext": ext, "kind": "photo" if f["mimeType"].startswith("image/") else "video",
               "added": db.now(), "use_count": 0, "deleted": False}
        try:
            p = clip_path(doc)
            doc["duration"] = 0.0 if doc["kind"] == "photo" else _probe_duration(p)
            fr = _frames(p)
            if not fr:
                raise RuntimeError("couldn't read frames")
            doc["desc"] = llm.describe_clip(fr, doc["duration"], doc["kind"] == "photo")
        except Exception as e:
            doc["desc"] = {"summary": f"(could not analyse: {e})", "quality": 1}
        db.clips.replace_one({"_id": f["id"]}, doc, upsert=True)
        new += 1
        print(f"[clips] added {f['name']}: {doc['desc'].get('summary')}", flush=True)
    return new


# ------------------------------------------------------------------ one job
def job_dir(job_id):
    d = os.path.join(config.WORK_DIR, "jobs", job_id)
    os.makedirs(d, exist_ok=True)
    return d


def process(job):
    jid = job["_id"]
    d = job_dir(jid)
    tdir = os.path.join(d, "template")
    src = os.path.join(d, "source.mp4")

    # 1) the reel
    if not os.path.exists(os.path.join(tdir, "template.json")):
        db.log(jid, "downloading the reel")
        _, meta = download.fetch(job["url"], src)
        db.jobs.update_one({"_id": jid}, {"$set": {"author": meta.get("author"), "title": meta.get("title")}})
        # 2) template
        db.log(jid, "building the template (cuts, text, audio)")
        name = f"{(meta.get('author') or download.platform(job['url']))}-{jid[:6]}"
        tpl = extract_video(src, tdir, name, job["url"])
        # 3) Claude cleans the text overlays and matches the font/style
        if tpl["texts"]:
            cap = cv2.VideoCapture(src)
            frames = []
            for t in tpl["texts"]:
                cap.set(cv2.CAP_PROP_POS_MSEC, (t["start"] + min(0.3, (t["end"] - t["start"]) / 2)) * 1000)
                ok, f = cap.read()
                frames.append(f if ok else cv2.imread(os.path.join(tdir, "thumbs", "slot_01.jpg")))
            cap.release()
            try:
                tpl["texts"] = llm.clean_texts(tpl["texts"], frames)
            except Exception as e:
                db.log(jid, f"text cleanup skipped: {e}")
            json.dump(tpl, open(os.path.join(tdir, "template.json"), "w"), indent=2)
        db.templates.replace_one({"_id": jid}, {"_id": jid, "source": job["url"], "template": tpl, "created": db.now()}, upsert=True)
    tpl = json.load(open(os.path.join(tdir, "template.json")))
    db.jobs.update_one({"_id": jid}, {"$set": {"template": {"slots": len(tpl["slots"]), "duration": tpl["duration"],
                                                              "texts": [t["text"] for t in tpl["texts"]]}}})

    # 4) pick clips
    catalogue = list(db.clips.find({"deleted": {"$ne": True}}))
    if not catalogue:
        raise RuntimeError("Your Raw Clips folder is empty (or not shared with the robot yet). Add clips, then tap Redo.")
    db.log(jid, f"matching {len(tpl['slots'])} shots against {len(catalogue)} clips")
    slot_frames = [cv2.imread(os.path.join(tdir, "thumbs", f"slot_{s['slot']:02d}.jpg")) for s in tpl["slots"]]
    picks, caption = llm.match_clips(slot_frames, tpl["slots"], catalogue, avoid=job.get("avoid", []))
    by_id = {c["_id"]: c for c in catalogue}
    used = set(picks.values())
    for s in tpl["slots"]:  # anything Claude left empty: longest unused clip
        if s["slot"] not in picks:
            spare = sorted(catalogue, key=lambda c: (c["_id"] in used, c.get("use_count", 0), -c.get("duration", 0)))
            picks[s["slot"]] = spare[0]["_id"]
            used.add(spare[0]["_id"])

    # 5) render
    media, chosen = [], []
    for s in tpl["slots"]:
        c = by_id[picks[s["slot"]]]
        p = clip_path(c)
        off = 0.0
        if c["kind"] == "video" and c.get("duration", 0) > s["dur"] + 0.6:
            off = 0.3  # skip the shaky first moment
        media.append(f"{p}@{off}" if off else p)
        chosen.append({"slot": s["slot"], "clip": c["_id"], "name": c["name"], "summary": c.get("desc", {}).get("summary")})
    db.log(jid, "rendering")
    out = os.path.join(d, "final.mp4")
    render_template(tdir, media, out)

    # 6) Drive
    fname = f"{dt.datetime.now().strftime('%Y-%m-%d %H%M')} {tpl['name']}.mp4"
    ready = {}
    if config.READY_FOLDER_ID:
        db.log(jid, "saving to Ready to Post")
        ready = drive.upload(out, config.READY_FOLDER_ID, fname)
    for c in used:
        db.clips.update_one({"_id": c}, {"$inc": {"use_count": 1}})
    token = job.get("media_token") or secrets.token_urlsafe(16)
    db.jobs.update_one({"_id": jid}, {"$set": {"status": "ready", "picks": chosen, "caption": job.get("caption") or caption,
                                               "drive_file_id": ready.get("id"), "drive_link": ready.get("webViewLink"),
                                               "media_token": token, "finished": db.now(), "error": None}})
    notify.push("Reel ready to review", f"{tpl['name']} - {len(tpl['slots'])} shots. Tap to approve.",
                click=f"{config.PUBLIC_URL}/?key={config.API_KEY}#job-{jid}")


def local_video(job):
    """Path to the rendered video, re-downloading from Drive if the server restarted."""
    p = os.path.join(job_dir(job["_id"]), "final.mp4")
    if not os.path.exists(p) and job.get("drive_file_id"):
        drive.download(job["drive_file_id"], p)
    return p
