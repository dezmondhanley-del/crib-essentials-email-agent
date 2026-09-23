"""All settings come from environment variables (set them in Render → Environment)."""
import os, json


def env(name, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else default


# --- required
MONGO_URI = env("MONGO_URI", "mongomock://localhost")
API_KEY = env("API_KEY", "dev-key")                      # shared secret: shortcut + review page
PUBLIC_URL = env("PUBLIC_URL", "http://localhost:8000").rstrip("/")
ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY")
CLAUDE_MODEL = env("CLAUDE_MODEL", "claude-sonnet-4-5")
CLAUDE_FAST_MODEL = env("CLAUDE_FAST_MODEL", "claude-haiku-4-5")

# --- Google Drive (service account JSON pasted as one env var)
GOOGLE_SERVICE_ACCOUNT_JSON = env("GOOGLE_SERVICE_ACCOUNT_JSON")
RAW_CLIPS_FOLDER_ID = env("RAW_CLIPS_FOLDER_ID")
READY_FOLDER_ID = env("READY_FOLDER_ID")

# --- notifications (free ntfy app; pick a hard-to-guess topic name)
NTFY_TOPIC = env("NTFY_TOPIC")
NTFY_SERVER = env("NTFY_SERVER", "https://ntfy.sh")

# --- reel downloading
APIFY_TOKEN = env("APIFY_TOKEN")                         # used for Instagram links
IG_COOKIES = env("IG_COOKIES")                           # optional Netscape cookie text for yt-dlp

# --- TikTok (Content Posting API, drafts)
TIKTOK_CLIENT_KEY = env("TIKTOK_CLIENT_KEY")
TIKTOK_CLIENT_SECRET = env("TIKTOK_CLIENT_SECRET")

# --- Instagram (Graph API, trial reels)
IG_USER_ID = env("IG_USER_ID")
IG_ACCESS_TOKEN = env("IG_ACCESS_TOKEN")
IG_GRAPH_HOST = env("IG_GRAPH_HOST", "graph.instagram.com")   # or graph.facebook.com for Page tokens
IG_GRAPH_VERSION = env("IG_GRAPH_VERSION", "v23.0")

# --- behaviour
POLL_SECONDS = int(env("POLL_SECONDS", "20"))
CLIP_SCAN_MINUTES = int(env("CLIP_SCAN_MINUTES", "10"))
WORK_DIR = env("WORK_DIR", "/tmp/cribcuts")
os.makedirs(WORK_DIR, exist_ok=True)


def service_account_info():
    if not GOOGLE_SERVICE_ACCOUNT_JSON:
        return None
    return json.loads(GOOGLE_SERVICE_ACCOUNT_JSON)
