"""TikTok: upload to the creator's inbox (shows up as a draft notification in the TikTok app).
Instagram: publish as a Trial Reel (shown to non-followers only until you share it to followers)."""
import json, math, os, time, urllib.parse, requests
from . import config, db

TT_AUTH = "https://www.tiktok.com/v2/auth/authorize/"
TT_TOKEN = "https://open.tiktokapis.com/v2/oauth/token/"
TT_INBOX_INIT = "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/"
TT_STATUS = "https://open.tiktokapis.com/v2/post/publish/status/fetch/"


# ------------------------------------------------------------------ TikTok
def tiktok_redirect_uri():
    return f"{config.PUBLIC_URL}/tiktok/callback"


def tiktok_auth_url(state):
    q = {"client_key": config.TIKTOK_CLIENT_KEY, "scope": "user.info.basic,video.upload",
         "response_type": "code", "redirect_uri": tiktok_redirect_uri(), "state": state}
    return TT_AUTH + "?" + urllib.parse.urlencode(q)


def _save_tt(tok):
    tok["expires_at"] = time.time() + int(tok.get("expires_in", 0)) - 120
    db.tokens.update_one({"_id": "tiktok"}, {"$set": tok}, upsert=True)
    return tok


def tiktok_exchange(code):
    r = requests.post(TT_TOKEN, data={"client_key": config.TIKTOK_CLIENT_KEY, "client_secret": config.TIKTOK_CLIENT_SECRET,
                                      "code": code, "grant_type": "authorization_code",
                                      "redirect_uri": tiktok_redirect_uri()},
                      headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=30)
    tok = r.json()
    if "access_token" not in tok:
        raise RuntimeError(f"TikTok login failed: {tok}")
    return _save_tt(tok)


def tiktok_token():
    tok = db.tokens.find_one({"_id": "tiktok"})
    if not tok:
        raise RuntimeError("TikTok isn't connected yet — open the review page and tap 'Connect TikTok'.")
    if time.time() < tok.get("expires_at", 0):
        return tok["access_token"]
    r = requests.post(TT_TOKEN, data={"client_key": config.TIKTOK_CLIENT_KEY, "client_secret": config.TIKTOK_CLIENT_SECRET,
                                      "grant_type": "refresh_token", "refresh_token": tok["refresh_token"]},
                      headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=30)
    new = r.json()
    if "access_token" not in new:
        raise RuntimeError(f"TikTok token refresh failed — reconnect TikTok. {new}")
    return _save_tt(new)["access_token"]


def tiktok_connected():
    return db.tokens.find_one({"_id": "tiktok"}) is not None


def tiktok_draft(path):
    size = os.path.getsize(path)
    MB = 1024 * 1024
    if size <= 64 * MB:
        chunk, count = size, 1
    else:
        chunk = 10 * MB
        count = size // chunk  # last chunk takes the remainder
    token = tiktok_token()
    r = requests.post(TT_INBOX_INIT, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=UTF-8"},
                      json={"source_info": {"source": "FILE_UPLOAD", "video_size": size, "chunk_size": chunk,
                                            "total_chunk_count": count}}, timeout=30).json()
    if r.get("error", {}).get("code") not in (None, "ok"):
        raise RuntimeError(f"TikTok init failed: {r['error']}")
    up, publish_id = r["data"]["upload_url"], r["data"]["publish_id"]
    with open(path, "rb") as f:
        for i in range(count):
            start = i * chunk
            end = size - 1 if i == count - 1 else start + chunk - 1
            f.seek(start)
            data = f.read(end - start + 1)
            pr = requests.put(up, data=data, headers={"Content-Type": "video/mp4", "Content-Length": str(len(data)),
                                                      "Content-Range": f"bytes {start}-{end}/{size}"}, timeout=300)
            if pr.status_code not in (200, 201, 206):
                raise RuntimeError(f"TikTok upload failed ({pr.status_code}): {pr.text[:300]}")
    return publish_id


# ------------------------------------------------------------------ Instagram
def _ig(path):
    return f"https://{config.IG_GRAPH_HOST}/{config.IG_GRAPH_VERSION}/{path}"


def ig_token():
    """Long-lived Instagram tokens last 60 days; refresh ours every ~20 days so it never lapses."""
    saved = db.tokens.find_one({"_id": "instagram"})
    tok = saved["token"] if saved and saved.get("seed") == config.IG_ACCESS_TOKEN else config.IG_ACCESS_TOKEN
    age = time.time() - (saved or {}).get("refreshed", 0) if saved and saved.get("seed") == config.IG_ACCESS_TOKEN else 1e9
    if config.IG_GRAPH_HOST == "graph.instagram.com" and age > 20 * 86400:
        try:
            r = requests.get("https://graph.instagram.com/refresh_access_token",
                             params={"grant_type": "ig_refresh_token", "access_token": tok}, timeout=30).json()
            if r.get("access_token"):
                tok = r["access_token"]
                db.tokens.update_one({"_id": "instagram"}, {"$set": {"token": tok, "seed": config.IG_ACCESS_TOKEN,
                                                                     "refreshed": time.time()}}, upsert=True)
        except Exception as e:
            print(f"[instagram] token refresh failed: {e}")
    return tok


def instagram_trial_reel(video_url, caption):
    if not (config.IG_USER_ID and config.IG_ACCESS_TOKEN):
        raise RuntimeError("Instagram isn't connected yet (IG_USER_ID / IG_ACCESS_TOKEN missing).")
    token = ig_token()
    r = requests.post(_ig(f"{config.IG_USER_ID}/media"), data={
        "media_type": "REELS", "video_url": video_url, "caption": caption or "", "share_to_feed": "true",
        "trial_params": json.dumps({"graduation_strategy": "MANUAL"}),
        "access_token": token}, timeout=60).json()
    if "id" not in r:
        raise RuntimeError(f"Instagram rejected the upload: {r.get('error', r)}")
    cid = r["id"]
    for _ in range(60):  # up to ~10 minutes of processing
        time.sleep(10)
        s = requests.get(_ig(cid), params={"fields": "status_code,status", "access_token": token}, timeout=30).json()
        code = s.get("status_code")
        if code == "FINISHED":
            break
        if code in ("ERROR", "EXPIRED"):
            raise RuntimeError(f"Instagram couldn't process the video: {s.get('status')}")
    else:
        raise RuntimeError("Instagram took too long to process the video.")
    p = requests.post(_ig(f"{config.IG_USER_ID}/media_publish"),
                      data={"creation_id": cid, "access_token": token}, timeout=60).json()
    if "id" not in p:
        raise RuntimeError(f"Instagram publish failed: {p.get('error', p)}")
    return p["id"]
