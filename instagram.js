// Instagram DMs as a second channel into the same support agent.
//
// Meta posts message events here; we hand the text to the existing
// /api/process-email pipeline (same FAQ, same Shopify lookup, same guess
// catcher) and then either send the reply back to Instagram or leave it for
// review.
//
// Shadow mode (IG_AUTOSEND unset or "false") is the default: the agent still
// decides send-vs-hold and records the decision, but nothing actually goes
// out. Read /api/instagram/decisions for a week before flipping
// IG_AUTOSEND=true.

const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');

const GRAPH = 'https://graph.instagram.com/v23.0';

const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const APP_SECRET = process.env.IG_APP_SECRET;
const IG_USER_ID = process.env.IG_USER_ID;
const AUTOSEND = String(process.env.IG_AUTOSEND || '').toLowerCase() === 'true';

// Meta's free-form reply window. Past this we cannot answer at all, so a held
// conversation that ages out gets flagged loudly rather than sitting quietly.
const WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Identity: an IG DM carries a sender ID, not an email. Once someone tells us
// which order or email is theirs we remember it, so we never ask twice.
// ---------------------------------------------------------------------------

const igUserSchema = new mongoose.Schema(
  {
    igId: { type: String, index: true, unique: true },
    username: String,
    name: String,
    email: String,
    linkedVia: String,
    lastOrderNumber: String,
    lastMessageAt: Date,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

let IgUser = null;
const memoryIgUsers = new Map();

function igModel() {
  if (!process.env.MONGODB_URI) return null;
  if (!IgUser) IgUser = mongoose.models.IgUser || mongoose.model('IgUser', igUserSchema);
  return IgUser;
}

async function getIgUser(igId) {
  const M = igModel();
  if (M) {
    try { return await M.findOne({ igId }).lean(); } catch (e) { /* fall through */ }
  }
  return memoryIgUsers.get(igId) || null;
}

async function saveIgUser(igId, patch) {
  const M = igModel();
  if (M) {
    try {
      await M.findOneAndUpdate({ igId }, { $set: patch }, { upsert: true });
      return;
    } catch (e) { /* fall through */ }
  }
  memoryIgUsers.set(igId, Object.assign({ igId }, memoryIgUsers.get(igId) || {}, patch));
}

// ---------------------------------------------------------------------------
// Meta plumbing
// ---------------------------------------------------------------------------

// Meta signs every delivery. Without this check anyone who finds the URL can
// make the bot answer - and on autosend that means anyone can make it talk.
function validSignature(req) {
  if (!APP_SECRET) return true; // not configured yet; log-only during setup
  const header = req.get('x-hub-signature-256');
  if (!header || !req.rawBody) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

// Meta retries deliveries. Answering the same DM twice is worse than missing
// one, so every message id is remembered for an hour.
const seen = new Map();
function alreadyHandled(mid) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 60 * 60 * 1000) seen.delete(k);
  if (seen.has(mid)) return true;
  seen.set(mid, now);
  return false;
}

async function igProfile(igId) {
  try {
    const url = `${GRAPH}/${igId}?fields=name,username&access_token=${ACCESS_TOKEN}`;
    const r = await fetch(url);
    if (!r.ok) return {};
    return await r.json();
  } catch (e) {
    return {};
  }
}

async function sendDM(recipientId, text) {
  const r = await fetch(`${GRAPH}/${IG_USER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ? data.error.message : `send failed (${r.status})`);
  return data;
}

// Instagram has no subject line and a 1000-byte cap. Long email-shaped replies
// get split rather than truncated mid-sentence.
function chunk(text, size = 900) {
  const clean = String(text || '').trim();
  if (clean.length <= size) return [clean];
  const parts = [];
  let rest = clean;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf('. ', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < 1) cut = size;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// ---------------------------------------------------------------------------
// Send-vs-hold
// ---------------------------------------------------------------------------

// The pipeline already flags anything the FAQ says to escalate (production-run
// timing, where things are made, health claims, discounts, free gifts, order
// mismatches, refund timing, arrival guesses). Those are the same rules here.
// What is added is Instagram-specific: no identity yet, and the window.
function decide(result, ctx) {
  if (result.needsHuman) {
    return { send: false, why: result.flagReason || 'Flagged by the agent' };
  }
  if (!result.reply || result.reply.trim().length < 20) {
    return { send: false, why: 'Reply came back empty or too short to send' };
  }
  if (ctx.wantsOrderInfo && !ctx.knownEmail) {
    return { send: true, why: null, asking: true };
  }
  return { send: true, why: null };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function buildRouter(options) {
  const opts = options || {};
  const router = express.Router();
  const selfUrl = opts.selfUrl || `http://127.0.0.1:${process.env.PORT || 3000}`;

  // Meta's one-time handshake when you click "Verify and save".
  router.get('/webhooks/instagram', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && token === VERIFY_TOKEN) {
      console.log('Instagram webhook verified');
      return res.status(200).send(challenge);
    }
    console.warn('Instagram webhook verification failed', { mode, gotToken: Boolean(token) });
    return res.sendStatus(403);
  });

  router.post('/webhooks/instagram', (req, res) => {
    if (!validSignature(req)) {
      console.warn('Instagram webhook: bad signature, ignoring');
      return res.sendStatus(403);
    }
    // Meta wants a 200 fast or it retries. Everything real happens after.
    res.sendStatus(200);

    const body = req.body || {};
    if (body.object !== 'instagram') return;

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        handleEvent(event, selfUrl).catch((err) =>
          console.error('Instagram event failed:', err.message)
        );
      }
    }
  });

  // Small status endpoint so you can see the channel is alive without a DM.
  router.get('/api/instagram/status', (req, res) => {
    res.json({
      configured: Boolean(VERIFY_TOKEN && ACCESS_TOKEN && IG_USER_ID),
      hasAppSecret: Boolean(APP_SECRET),
      autosend: AUTOSEND,
      mode: AUTOSEND ? 'live - replies go out automatically' : 'shadow - decisions recorded, nothing sent',
    });
  });

  // Shadow-mode review: what the agent decided, and what it would have said.
  router.get('/api/instagram/decisions', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    res.json({ autosend: AUTOSEND, decisions: await recentDecisions(limit) });
  });

  return router;
}

async function handleEvent(event, selfUrl) {
  // Echoes are our own outgoing messages coming back. Ignore or we loop.
  if (event.message && event.message.is_echo) return;
  if (!event.message || !event.message.text) return;      // reactions, seen, media-only
  if (!event.sender || !event.sender.id) return;
  if (event.sender.id === IG_USER_ID) return;

  const mid = event.message.mid;
  if (mid && alreadyHandled(mid)) return;

  const igId = event.sender.id;
  const text = event.message.text.trim();
  if (!text) return;

  const known = await getIgUser(igId);
  let profile = { username: known && known.username, name: known && known.name };
  if (!profile.username) profile = await igProfile(igId);

  const displayName = profile.name || profile.username || 'Instagram customer';
  // The pipeline keys off an email. Until they tell us theirs, we use a stable
  // placeholder so the conversation still threads correctly in the Inbox.
  const email = (known && known.email) || `${profile.username || igId}@instagram.local`;

  await saveIgUser(igId, {
    username: profile.username,
    name: profile.name,
    lastMessageAt: new Date(),
  });

  // Hand it to the same brain the email agent uses.
  let result;
  try {
    const r = await fetch(`${selfUrl}/api/process-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: email,
        customerName: displayName,
        body: text,
        subject: `Instagram DM from @${profile.username || igId}`,
        threadId: `ig:${igId}`,
        receivedAt: new Date(event.timestamp || Date.now()).toISOString(),
        quiet: true,
      }),
    });
    result = await r.json();
  } catch (err) {
    console.error('Instagram: pipeline call failed:', err.message);
    return;
  }

  if (!result || !result.success) {
    console.error('Instagram: pipeline returned an error', result && result.error);
    return;
  }

  const wantsOrderInfo = /order|shipp|track|deliver|where.?s my|refund|return|cancel/i.test(text);
  const call = decide(result, {
    wantsOrderInfo,
    knownEmail: Boolean(known && known.email),
  });

  const stamp = {
    igId,
    username: profile.username || null,
    question: text,
    reply: result.reply || null,
    wouldSend: call.send,
    holdReason: call.why || null,
    sent: false,
  };

  if (!call.send) {
    console.log(`Instagram: holding for review - ${call.why}`);
    await mark(result.id, stamp);
    return;
  }

  if (!AUTOSEND) {
    console.log('Instagram: shadow mode, would have sent');
    await mark(result.id, stamp);
    return;
  }

  // Live. Check the window before trying, so an expired conversation gets a
  // clear flag instead of a confusing Meta error.
  const age = Date.now() - new Date(event.timestamp || Date.now()).getTime();
  if (age > WINDOW_MS) {
    await mark(result.id, Object.assign({}, stamp, {
      wouldSend: false,
      holdReason: 'Outside the 24-hour reply window - Instagram will not accept a reply',
    }));
    return;
  }

  try {
    for (const part of chunk(result.reply)) {
      await sendDM(igId, part);
    }
    await mark(result.id, Object.assign({}, stamp, { sent: true }));
    console.log(`Instagram: replied to @${profile.username || igId}`);
  } catch (err) {
    console.error('Instagram: send failed:', err.message);
    await mark(result.id, Object.assign({}, stamp, {
      wouldSend: false,
      holdReason: `Send failed: ${err.message}`,
    }));
  }
}

// Decisions live in their own collection rather than on the lead, so this
// module needs no schema change in server.js. Read them at
// /api/instagram/decisions during the shadow-mode week.
const decisionSchema = new mongoose.Schema(
  {
    leadId: String,
    igId: String,
    username: String,
    question: String,
    reply: String,
    wouldSend: Boolean,
    holdReason: String,
    sent: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

let Decision = null;
const memoryDecisions = [];

function decisionModel() {
  if (!process.env.MONGODB_URI) return null;
  if (!Decision) {
    Decision = mongoose.models.IgDecision || mongoose.model('IgDecision', decisionSchema);
  }
  return Decision;
}

async function mark(leadId, record) {
  const row = Object.assign({ leadId: leadId || null, createdAt: new Date() }, record);
  const M = decisionModel();
  if (M) {
    try {
      await M.create(row);
      return;
    } catch (err) {
      console.error('Instagram: could not save decision:', err.message);
    }
  }
  memoryDecisions.unshift(row);
  if (memoryDecisions.length > 200) memoryDecisions.pop();
}

async function recentDecisions(limit) {
  const M = decisionModel();
  if (M) {
    try {
      return await M.find({}).sort({ createdAt: -1 }).limit(limit).lean();
    } catch (err) { /* fall through */ }
  }
  return memoryDecisions.slice(0, limit);
}

module.exports = { buildRouter };
