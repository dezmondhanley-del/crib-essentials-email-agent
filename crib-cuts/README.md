# Crib Cuts worker

Share any Reel or TikTok → it becomes a template (same cuts, text, sound) → Claude picks your clips from
**Drive › Crib Cuts › Raw Clips** → the video is rendered and saved to **Drive › Crib Cuts › Ready to Post** →
your phone buzzes → you tap **Approve & post** → it lands in your **TikTok drafts** and goes up as an
**Instagram Trial Reel** (non-followers only until you share it to followers).

Runs 24/7 on Render. Your Mac can be off.

---

## What it costs (roughly)

| Thing | Cost |
|---|---|
| Render "Standard" instance (2 GB memory — video needs it) | $25 / month |
| Claude API (describing clips + picking + text cleanup) | a few cents per reel |
| Apify (downloads Instagram reels) | free $5 credit each month covers ~hundreds of reels |
| MongoDB, ntfy, Google Drive, TikTok, Instagram APIs | free |

---

## Setup — do these in order

Each part ends with something to paste into Render. Keep a note open and collect them as you go.

### Part 1 — Google Drive key (so the server can read clips and save videos)

1. Go to **console.cloud.google.com** and sign in with dezmondhanley@gmail.com.
2. At the top left, click the project dropdown → **New Project** → name it `crib-cuts` → **Create**. Make sure it's selected.
3. In the search bar at the top type **Google Drive API** → click it → **Enable**.
4. In the search bar type **Service Accounts** → click it → **+ Create service account**.
5. Name: `crib-cuts-robot` → **Create and continue** → skip the role → **Done**.
6. Click the new service account in the list → **Keys** tab → **Add key** → **Create new key** → **JSON** → **Create**. A `.json` file downloads.
7. Open that file in TextEdit, select everything, copy it. → **Paste into your note as `GOOGLE_SERVICE_ACCOUNT_JSON`.**
8. In the same file find the line `"client_email": "crib-cuts-robot@....iam.gserviceaccount.com"`. Copy that email.
9. Go to **drive.google.com** → open the **Crib Cuts** folder → right-click **Crib Cuts** (the folder itself) → **Share** → paste the robot email → set it to **Editor** → untick "Notify people" → **Share**.

Folder IDs (already created for you):
- `RAW_CLIPS_FOLDER_ID` = `1vlU-X60uweTZOvZlbWvrySLlnu_e6bBC`
- `READY_FOLDER_ID` = `19t7fgwtYaLCy1qScNDsr-yaWIS7YMlMe`

### Part 2 — Database

1. Go to **dashboard.render.com** → open your **crib-essentials-email-agent** service → **Environment**.
2. Find `MONGO_URI` (or `MONGODB_URI`), click the eye icon, copy the value. → **Paste into your note as `MONGO_URI`.**
   (Crib Cuts uses its own database called `cribcuts` inside the same cluster, so it never touches the email agent's data.)

### Part 3 — Claude API key

1. Same Environment page → copy `ANTHROPIC_API_KEY`. → **Paste into your note.**

### Part 4 — Apify (downloads Instagram reels)

1. Go to **console.apify.com** and sign in (or sign up free).
2. Left menu → **Settings** → **API & Integrations** → copy the **Personal API token**. → **Paste into your note as `APIFY_TOKEN`.**

### Part 5 — Phone notifications (ntfy)

1. On your iPhone install the free app **ntfy** from the App Store.
2. Open it → tap **+** → topic name: make up something nobody would guess, like `cribcuts-dez-7h3k9` → **Subscribe**.
3. Allow notifications when it asks. → **Paste the topic name into your note as `NTFY_TOPIC`.**

### Part 6 — Make a password

Make up a long random password (for example mash the keyboard: `k29Fqz81LmPx0`). → **Paste into your note as `API_KEY`.**
Anyone with this can queue videos, so don't share it.

### Part 7 — Put it on Render

1. **dashboard.render.com** → **+ New** → **Web Service**.
2. Pick the repo **crib-essentials-email-agent** → then set:
   - **Branch:** `crib-cuts`  ← important, NOT main
   - **Root Directory:** `crib-cuts`
   - **Language / Runtime:** Docker
   - **Name:** `crib-cuts`
   - **Instance type:** Standard (2 GB)
3. Scroll to **Environment Variables** → **Add from .env** → paste this, filling in from your note:

```
MONGO_URI=
API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_SERVICE_ACCOUNT_JSON=
RAW_CLIPS_FOLDER_ID=1vlU-X60uweTZOvZlbWvrySLlnu_e6bBC
READY_FOLDER_ID=19t7fgwtYaLCy1qScNDsr-yaWIS7YMlMe
APIFY_TOKEN=
NTFY_TOPIC=
PUBLIC_URL=https://crib-cuts.onrender.com
```
   (For `GOOGLE_SERVICE_ACCOUNT_JSON` paste the whole file contents on one line — Render accepts it.)
4. Click **Deploy Web Service**. The first build takes ~5–8 minutes.
5. When it says **Live**, check the web address at the top of the page. If it isn't exactly `https://crib-cuts.onrender.com`, change `PUBLIC_URL` to match and save.
6. Open `https://crib-cuts.onrender.com/?key=YOUR_API_KEY` on your phone → **Share → Add to Home Screen**. That's your review screen.

### Part 8 — The share button on your iPhone

1. Open the **Shortcuts** app → **+** (top right).
2. Tap the name at the top → **Rename** → `Crib Template`.
3. Tap the **ⓘ** (bottom) → turn on **Show in Share Sheet** → **Done**. Set "Receive" to **URLs and Text**.
4. Tap **Add Action** → search **Get Contents of URL** → add it.
5. Tap **URL** → type `https://crib-cuts.onrender.com/api/queue`.
6. Tap the **›** arrow → **Method: POST** → **Request Body: JSON** → **Add new field → Text**:
   - key `url` → value: tap and pick **Shortcut Input**
   - add another Text field: key `key` → value: your `API_KEY`
7. Add action **Show Notification** → text: `Sent to Crib Cuts`.
8. Done. Now in Instagram or TikTok tap **Share** → scroll the bottom row → **More / Share to…** → **Crib Template**. (First time only: tap **Edit Actions** and add Crib Template to your favourites so it's always there.)

### Part 9 — TikTok drafts (one-time)

1. Go to **developers.tiktok.com** → log in with your TikTok → **Manage apps** → **Connect an app**.
2. Name it `Crib Cuts`, category Utility. Fill description, add an icon (any square logo), terms/privacy URLs (your store's policy pages).
3. **Add products:** **Login Kit** and **Content Posting API**.
4. In Login Kit → **Redirect URI** → `https://crib-cuts.onrender.com/tiktok/callback`.
5. In Scopes make sure **user.info.basic** and **video.upload** are on.
6. Go to **Sandbox** (top) → create a sandbox → **Target users** → add your TikTok account.
7. Copy **Client key** and **Client secret** → add them in Render Environment as `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` → save.
8. Open your review screen → tap **Connect TikTok** → log in → allow. It says "TikTok connected".

Drafts appear in the TikTok app as a notification in your inbox — tap it to finish posting. (Submitting the app for review later removes the sandbox limits; drafts work in sandbox for your own account.)

### Part 10 — Instagram Trial Reels (one-time)

You already have a Meta app for the Instagram DM bot. In it:

1. **developers.facebook.com** → **My Apps** → open the app → **Instagram** → **API setup with Instagram login**.
2. Under permissions make sure **instagram_business_content_publish** is added.
3. Under **Generate access tokens** → next to your Instagram account tap **Generate token** → log in → copy the token.
4. The same row shows your Instagram **user ID** (numbers).
5. In Render Environment add `IG_ACCESS_TOKEN` (the token) and `IG_USER_ID` (the numbers) → save.

The server refreshes this token on its own so it doesn't expire.

---

## Using it

1. Film clips whenever, drop them in **Drive › Crib Cuts › Raw Clips** (phone Drive app → **+** → Upload). The server looks every 10 minutes and has Claude describe each new clip once.
2. See a reel you like → **Share → Crib Template**.
3. A few minutes later your phone buzzes **Reel ready to review** → tap it.
4. Watch it. Then:
   - **Approve & post** → TikTok draft + Instagram Trial Reel (untick either box to skip it)
   - **Different clips** → Claude re-picks, avoiding the clips it used
   - **Reject** → hides it
5. Every finished video is also in **Drive › Crib Cuts › Ready to Post**.

## Settings you can add later

| Variable | What it does |
|---|---|
| `CLAUDE_MODEL` / `CLAUDE_FAST_MODEL` | Which Claude models to use |
| `CLIP_SCAN_MINUTES` | How often to look for new clips (default 10) |
| `IG_COOKIES` | Instagram cookies for downloading without Apify |
| `IG_GRAPH_HOST` | `graph.facebook.com` if you use a Facebook Page token instead |

## Files

- `app/server.py` — web server, review page, background worker
- `app/pipeline.py` — download → template → pick clips → render → Drive → notify
- `app/extract_template.py`, `app/render.py` — the template engine (same one as Crib Cuts / your Mac)
- `app/llm.py` — the Claude prompts
- `app/publish.py` — TikTok drafts + Instagram Trial Reels
