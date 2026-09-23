"""Download the shared Reel / TikTok. TikTok: yt-dlp. Instagram: Apify (reliable), yt-dlp as fallback."""
import os, re, requests
from . import config


def platform(url):
    if "tiktok.com" in url:
        return "tiktok"
    if "instagram.com" in url:
        return "instagram"
    return "other"


def clean_url(url):
    return url.split("?")[0] if "instagram.com" in url else url


def _ytdlp(url, dest):
    import yt_dlp
    opts = {"outtmpl": dest, "format": "mp4/best[ext=mp4]/best", "quiet": True, "noplaylist": True,
            "merge_output_format": "mp4"}
    if config.IG_COOKIES and "instagram.com" in url:
        ck = os.path.join(config.WORK_DIR, "ig_cookies.txt")
        open(ck, "w").write(config.IG_COOKIES)
        opts["cookiefile"] = ck
    with yt_dlp.YoutubeDL(opts) as y:
        info = y.extract_info(url, download=True)
    return dest, {"author": info.get("uploader") or info.get("channel"), "title": info.get("title")}


def _apify_instagram(url, dest):
    r = requests.post("https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items",
                      params={"token": config.APIFY_TOKEN, "timeout": 120},
                      json={"directUrls": [url], "resultsType": "posts", "resultsLimit": 1}, timeout=180)
    r.raise_for_status()
    items = r.json()
    if not items or not items[0].get("videoUrl"):
        raise RuntimeError("Apify returned no video for this link (is it a photo post or private?)")
    it = items[0]
    with requests.get(it["videoUrl"], stream=True, timeout=120) as v:
        v.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in v.iter_content(1 << 20):
                f.write(chunk)
    return dest, {"author": it.get("ownerUsername"), "title": (it.get("caption") or "")[:80]}


def fetch(url, dest):
    url = clean_url(url)
    errors = []
    tries = []
    if platform(url) == "instagram" and config.APIFY_TOKEN:
        tries.append(_apify_instagram)
    tries.append(_ytdlp)
    for fn in tries:
        try:
            return fn(url, dest)
        except Exception as e:
            errors.append(f"{fn.__name__}: {e}")
    raise RuntimeError("Couldn't download the video. " + " | ".join(errors))


def find_url(text):
    m = re.search(r"https?://\S+", text or "")
    return m.group(0).rstrip(").,") if m else None
