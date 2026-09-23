"""MongoDB collections. Uses the 'cribcuts' database (separate from the email agent)."""
import datetime as dt
from . import config

if config.MONGO_URI.startswith("mongomock://"):
    import mongomock
    _client = mongomock.MongoClient()
else:
    from pymongo import MongoClient
    _client = MongoClient(config.MONGO_URI)

db = _client["cribcuts"]
jobs = db["jobs"]          # one per shared link
clips = db["clips"]        # catalogue of Raw Clips (Drive) with Claude descriptions
templates = db["templates"]
tokens = db["tokens"]      # TikTok OAuth tokens


def now():
    return dt.datetime.now(dt.timezone.utc)


def log(job_id, msg):
    print(f"[job {job_id}] {msg}", flush=True)
    jobs.update_one({"_id": job_id}, {"$push": {"log": {"t": now(), "msg": msg}}})
