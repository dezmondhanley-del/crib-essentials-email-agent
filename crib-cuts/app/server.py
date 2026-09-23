"""Crib Cuts worker: web server + background worker in one process.

Routes
  POST /api/queue              iPhone shortcut sends {"url": "...", "key": "..."}
  GET  /?key=...               review page (phone friendly)
  POST /api/jobs/{id}/approve  {"caption", "tiktok": bool, "instagram": bool}
  POST /api/jobs/{id}/redo     pick different clips
  POST /api/jobs/{id}/reject
  GET  /media/{id}.mp4?t=...   public link Instagram downloads the video from
  GET  /tiktok/connect         one-time TikTok login
"""
import html, json, os, secrets, threading, time, traceback, uuid
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, FileResponse, RedirectResponse, JSONResponse
from . import config, db, pipeline, publish, notify, download

app = FastAPI(title="Crib Cuts")


# ------------------------------------------------------------------ auth
def check_key(request: Request, body: dict | None = None):
    k = (request.query_params.get("key") or request.headers.get("x-key") or request.cookies.get("cc_key")
         or (body or {}).get("key"))
    if not k or not secrets.compare_digest(str(k), config.API_KEY):
        raise HTTPException(401, "wrong or missing key")


async def body_json(request: Request):
    try:
        return await request.json()
    except Exception:
        form = await request.form()
        return dict(form)


# ------------------------------------------------------------------ queue (from the share shortcut)
@app.post("/api/queue")
async def queue(request: Request):
    body = await body_json(request)
    check_key(request, body)
    url = download.find_url(str(body.get("url") or body.get("text") or ""))
    if not url:
        raise HTTPException(400, "no link found")
    if db.jobs.find_one({"url": download.clean_url(url), "status": {"$in": ["queued", "working"]}}):
        return {"ok": True, "message": "Already in the queue"}
    jid = uuid.uuid4().hex[:12]
    db.jobs.insert_one({"_id": jid, "url": download.clean_url(url), "status": "queued", "created": db.now(),
                        "attempts": 0, "log": []})
    return {"ok": True, "id": jid, "message": "Got it - I'll send you a notification when it's ready."}


# ------------------------------------------------------------------ review actions
def _job(jid):
    j = db.jobs.find_one({"_id": jid})
    if not j:
        raise HTTPException(404, "job not found")
    return j


def _do_publish(jid, want_tiktok, want_ig, caption):
    job = db.jobs.find_one({"_id": jid})
    results = {}
    try:
        path = pipeline.local_video(job)
        if want_tiktok:
            try:
                results["tiktok"] = {"ok": True, "publish_id": publish.tiktok_draft(path)}
            except Exception as e:
                results["tiktok"] = {"ok": False, "error": str(e)}
        if want_ig:
            try:
                url = f"{config.PUBLIC_URL}/media/{jid}.mp4?t={job['media_token']}"
                results["instagram"] = {"ok": True, "media_id": publish.instagram_trial_reel(url, caption)}
            except Exception as e:
                results["instagram"] = {"ok": False, "error": str(e)}
    except Exception as e:
        results["error"] = str(e)
    ok = all(v.get("ok") for v in results.values() if isinstance(v, dict)) and "error" not in results
    db.jobs.update_one({"_id": jid}, {"$set": {"status": "posted" if ok else "post_failed", "publish": results,
                                               "posted": db.now()}})
    parts = []
    if "tiktok" in results:
        parts.append("TikTok draft sent - open TikTok's inbox to finish" if results["tiktok"]["ok"] else f"TikTok failed: {results['tiktok']['error'][:120]}")
    if "instagram" in results:
        parts.append("Instagram Trial Reel is live" if results["instagram"]["ok"] else f"Instagram failed: {results['instagram']['error'][:120]}")
    notify.push("Posted" if ok else "Posting problem", "; ".join(parts) or results.get("error", ""),
                click=f"{config.PUBLIC_URL}/?key={config.API_KEY}#job-{jid}")


@app.post("/api/jobs/{jid}/approve")
async def approve(jid: str, request: Request):
    body = await body_json(request)
    check_key(request, body)
    job = _job(jid)
    if job["status"] not in ("ready", "post_failed"):
        raise HTTPException(409, f"can't approve a job that is {job['status']}")
    caption = str(body.get("caption", job.get("caption", "")))[:2200]
    want_tt = str(body.get("tiktok", "true")).lower() in ("true", "1", "on")
    want_ig = str(body.get("instagram", "true")).lower() in ("true", "1", "on")
    db.jobs.update_one({"_id": jid}, {"$set": {"status": "posting", "caption": caption}})
    threading.Thread(target=_do_publish, args=(jid, want_tt, want_ig, caption), daemon=True).start()
    return {"ok": True}


@app.post("/api/jobs/{jid}/redo")
async def redo(jid: str, request: Request):
    body = await body_json(request)
    check_key(request, body)
    job = _job(jid)
    avoid = [p["clip"] for p in job.get("picks", [])]
    db.jobs.update_one({"_id": jid}, {"$set": {"status": "queued", "avoid": avoid, "attempts": 0, "error": None}})
    return {"ok": True}


@app.post("/api/jobs/{jid}/reject")
async def reject(jid: str, request: Request):
    body = await body_json(request)
    check_key(request, body)
    _job(jid)
    db.jobs.update_one({"_id": jid}, {"$set": {"status": "rejected"}})
    return {"ok": True}


@app.post("/api/scan")
async def scan_now(request: Request):
    check_key(request, await body_json(request))
    threading.Thread(target=_safe_scan, daemon=True).start()
    return {"ok": True}


# ------------------------------------------------------------------ media (Instagram pulls from here)
@app.get("/media/{jid}.mp4")
def media(jid: str, t: str = ""):
    job = _job(jid)
    if not t or not secrets.compare_digest(t, job.get("media_token", "")):
        raise HTTPException(403, "bad token")
    p = pipeline.local_video(job)
    if not os.path.exists(p):
        raise HTTPException(404, "video not found")
    return FileResponse(p, media_type="video/mp4")


# ------------------------------------------------------------------ TikTok login
@app.get("/tiktok/connect")
def tiktok_connect(request: Request):
    check_key(request)
    state = secrets.token_urlsafe(12)
    db.tokens.update_one({"_id": "tiktok_state"}, {"$set": {"state": state, "t": time.time()}}, upsert=True)
    return RedirectResponse(publish.tiktok_auth_url(state))


@app.get("/tiktok/callback")
def tiktok_callback(code: str = "", state: str = "", error: str = ""):
    saved = db.tokens.find_one({"_id": "tiktok_state"}) or {}
    if error or not code or state != saved.get("state"):
        return HTMLResponse(f"<h3>TikTok login didn't finish: {html.escape(error or 'state mismatch')}</h3>", 400)
    publish.tiktok_exchange(code)
    return HTMLResponse(f"<meta name=viewport content='width=device-width'><body style='font:18px system-ui;padding:24px'>"
                        f"<h2>TikTok connected ✅</h2><p><a href='{config.PUBLIC_URL}/'>Back to Crib Cuts</a></p>")


@app.get("/health")
def health():
    return {"ok": True, "queued": db.jobs.count_documents({"status": "queued"}),
            "clips": db.clips.count_documents({"deleted": {"$ne": True}})}


# ------------------------------------------------------------------ review page
STATUS = {"queued": ("Waiting", "#9b938a"), "working": ("Making it", "#e6b673"), "ready": ("Ready to review", "#8fc9a0"),
          "posting": ("Posting", "#e6b673"), "posted": ("Posted", "#8fc9a0"), "post_failed": ("Posting problem", "#e8836b"),
          "failed": ("Failed", "#e8836b"), "rejected": ("Rejected", "#6b655e")}


def card(j):
    jid = j["_id"]
    label, color = STATUS.get(j["status"], (j["status"], "#9b938a"))
    e = html.escape
    parts = [f"<article class='job' id='job-{jid}'><header><span class='dot' style='background:{color}'></span>"
             f"<b>{e(label)}</b><span class='muted'>{e((j.get('author') or '') and '@' + j['author'])}</span>"
             f"<a class='src' href='{e(j['url'])}' target='_blank' rel='noopener'>original ↗</a></header>"]
    if j["status"] in ("ready", "posting", "posted", "post_failed") and j.get("media_token"):
        parts.append(f"<video src='/media/{jid}.mp4?t={j['media_token']}' controls playsinline preload='metadata'></video>")
    if j.get("template"):
        t = j["template"]
        parts.append(f"<p class='muted'>{t['slots']} shot{'s' if t['slots'] != 1 else ''} · {t['duration']:.1f}s"
                     + (f" · text: “{e(' / '.join(x.replace(chr(10), ' ') for x in t['texts']))}”" if t.get("texts") else "") + "</p>")
    if j.get("picks"):
        parts.append("<details><summary>Clips it picked</summary><ol>" + "".join(
            f"<li>{e(p['name'])} <span class='muted'>— {e(p.get('summary') or '')}</span></li>" for p in j["picks"]) + "</ol></details>")
    if j["status"] in ("ready", "post_failed"):
        parts.append(f"""<form onsubmit="return act(event,'{jid}','approve')">
          <label for='cap-{jid}'>Caption</label>
          <textarea id='cap-{jid}' name='caption' rows='3'>{e(j.get('caption') or '')}</textarea>
          <div class='row'><label><input type='checkbox' name='tiktok' checked> TikTok draft</label>
          <label><input type='checkbox' name='instagram' checked> Instagram Trial Reel</label></div>
          <div class='row'><button class='go'>Approve & post</button>
          <button type='button' onclick="act(event,'{jid}','redo')">Different clips</button>
          <button type='button' class='ghost' onclick="act(event,'{jid}','reject')">Reject</button></div></form>""")
    if j["status"] == "failed":
        parts.append(f"<p class='err'>{e(j.get('error') or '')}</p><div class='row'>"
                     f"<button onclick=\"act(event,'{jid}','redo')\">Try again</button>"
                     f"<button class='ghost' onclick=\"act(event,'{jid}','reject')\">Dismiss</button></div>")
    if j.get("publish"):
        for k, v in j["publish"].items():
            if isinstance(v, dict):
                parts.append(f"<p class='{'ok' if v.get('ok') else 'err'}'>{e(k.title())}: "
                             f"{'done' if v.get('ok') else e(v.get('error', ''))}</p>")
    if j["status"] in ("queued", "working") and j.get("log"):
        parts.append(f"<p class='muted'>{e(j['log'][-1]['msg'])}…</p>")
    if j.get("drive_link"):
        parts.append(f"<p><a href='{e(j['drive_link'])}' target='_blank' rel='noopener'>Open in Drive ↗</a></p>")
    parts.append("</article>")
    return "".join(parts)


@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    check_key(request)
    jobs = list(db.jobs.find({"status": {"$ne": "rejected"}}).sort("created", -1).limit(30))
    nclips = db.clips.count_documents({"deleted": {"$ne": True}})
    tt = publish.tiktok_connected()
    ig = bool(config.IG_USER_ID and config.IG_ACCESS_TOKEN)
    body = "".join(card(j) for j in jobs) or "<p class='muted'>Nothing yet. Share a Reel or TikTok with the Crib Template shortcut.</p>"
    resp = HTMLResponse(PAGE.replace("{{JOBS}}", body).replace("{{CLIPS}}", str(nclips))
                        .replace("{{TT}}", "connected" if tt else "<a href='/tiktok/connect'>Connect TikTok</a>")
                        .replace("{{IG}}", "connected" if ig else "not set up"))
    if request.query_params.get("key"):
        resp.set_cookie("cc_key", config.API_KEY, max_age=60 * 60 * 24 * 365, httponly=True, samesite="lax", secure=True)
    return resp


PAGE = """<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Crib Cuts Queue</title><style>
:root{color-scheme:dark;--ink:#0f0e0d;--panel:#1a1816;--raise:#24211e;--line:#34302b;--text:#f3eee7;--muted:#9b938a;--brass:#e6b673}
body{margin:0;background:var(--ink);color:var(--text);font:15px/1.45 -apple-system,system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}h1 span{color:var(--brass)}
.stats{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin-bottom:18px}.stats a{color:var(--brass)}
.job{background:var(--panel);border-radius:16px;padding:14px;margin-bottom:14px}
.job header{display:flex;align-items:center;gap:8px;margin-bottom:10px}.dot{width:9px;height:9px;border-radius:50%}
.src{margin-left:auto;color:var(--muted);font-size:13px}.muted{color:var(--muted);font-size:13px}
video{width:100%;max-height:70vh;border-radius:12px;background:#000;display:block;margin-bottom:10px}
label{font-size:13px;color:var(--muted)}textarea{width:100%;box-sizing:border-box;background:var(--raise);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit;margin:4px 0 8px}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}.row label{display:flex;gap:6px;align-items:center;color:var(--text)}
button{font:inherit;border:0;border-radius:10px;padding:10px 14px;background:var(--raise);color:var(--text);cursor:pointer}
button.go{background:var(--brass);color:#1c1409;font-weight:600;flex:1}button.ghost{background:none;color:var(--muted)}
details{margin:6px 0}summary{cursor:pointer;color:var(--muted);font-size:13px}ol{padding-left:20px;margin:6px 0}
.err{color:#e8836b}.ok{color:#8fc9a0}a{color:var(--brass)}
</style></head><body><main><h1>Crib <span>Cuts</span> queue</h1>
<div class=stats><span>{{CLIPS}} clips in Raw Clips <a href="#" onclick="scan(event)">scan now</a></span><span>TikTok: {{TT}}</span><span>Instagram: {{IG}}</span></div>
{{JOBS}}</main><script>
async function act(ev,id,what){ev.preventDefault();const f=ev.target.closest('form');const b={};
 if(f&&what==='approve'){b.caption=f.caption.value;b.tiktok=f.tiktok.checked;b.instagram=f.instagram.checked;}
 const r=await fetch('/api/jobs/'+id+'/'+what,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
 if(!r.ok){alert((await r.json()).detail||'Something went wrong');return false}location.reload();return false}
async function scan(ev){ev.preventDefault();await fetch('/api/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});ev.target.textContent='scanning…'}
if([...document.querySelectorAll('.job b')].some(b=>/Waiting|Making|Posting$/.test(b.textContent)))setTimeout(()=>location.reload(),15000);
</script></body></html>"""


# ------------------------------------------------------------------ background worker
def _safe_scan():
    try:
        n = pipeline.scan_clips()
        if n:
            print(f"[clips] {n} new clip(s) described", flush=True)
    except Exception as e:
        print(f"[clips] scan failed: {e}", flush=True)


def worker_loop():
    db.jobs.update_many({"status": "working"}, {"$set": {"status": "queued"}})  # recover after a restart
    last_scan = 0
    while True:
        try:
            if time.time() - last_scan > config.CLIP_SCAN_MINUTES * 60:
                last_scan = time.time()
                _safe_scan()
            job = db.jobs.find_one_and_update({"status": "queued"}, {"$set": {"status": "working", "started": db.now()},
                                                                      "$inc": {"attempts": 1}}, sort=[("created", 1)])
            if job:
                if job.get("attempts", 0) >= 3:
                    db.jobs.update_one({"_id": job["_id"]}, {"$set": {"status": "failed", "error": "Gave up after 3 tries."}})
                    continue
                if db.clips.count_documents({"deleted": {"$ne": True}}) == 0:
                    _safe_scan()
                try:
                    pipeline.process(job)
                except BaseException as e:  # render/extract use sys.exit on ffmpeg errors
                    traceback.print_exc()
                    msg = str(e) or e.__class__.__name__
                    db.jobs.update_one({"_id": job["_id"]}, {"$set": {"status": "failed", "error": msg[:600]}})
                    notify.push("Reel failed", msg[:200], click=f"{config.PUBLIC_URL}/?key={config.API_KEY}#job-{job['_id']}")
                continue
        except Exception:
            traceback.print_exc()
        time.sleep(config.POLL_SECONDS)


@app.on_event("startup")
def start_worker():
    if os.environ.get("DISABLE_WORKER") != "1":
        threading.Thread(target=worker_loop, daemon=True).start()
