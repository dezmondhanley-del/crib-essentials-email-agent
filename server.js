const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(cors());
// Customer photos arrive base64-encoded from the Gmail import, so the body
// limit is well above Express's 100kb default.
app.use(express.json({ limit: '12mb' }));

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// Leads go to MongoDB when MONGODB_URI is set. If the database is missing or
// unreachable the service keeps running and falls back to memory, so a bad
// connection string can never stop the bot from answering email.
const memoryLeads = [];
const MAX_LEADS = 500;
let nextId = 1;

const MONGODB_URI = process.env.MONGODB_URI;
let dbReady = false;
let dbError = null;
let Lead = null;

const leadSchema = new mongoose.Schema(
  {
    email: String,
    customerName: String,
    question: String,
    orderNumber: String,
    productType: String,
    shopifyOrderData: Object,
    matchedProducts: [String],
    customerOrders: [String],
    customerTotalOrders: String,
    aiAnalysis: String,
    aiResponse: String,
    threadId: String,
    subject: String,
    // When the customer sent the email (createdAt is when the bot processed it).
    receivedAt: Date,
    status: { type: String, default: 'drafted' },
    needsHuman: { type: Boolean, default: false },
    flagReason: String,
    // "customer" for people who bought or want to buy; "other" for vendor
    // pitches, collab requests, newsletters, spam. The Inbox keeps "other"
    // out of the main list. Dezmond can flip it from the dashboard.
    audience: { type: String, default: 'customer' },
    audienceSetBy: String,
    // Three ways of saying the same thing. drafts[0] is always the vetted
    // original; the others are tone rewrites that may not add facts.
    drafts: [{ tone: String, label: String, text: String }],
    // Shopify Inbox-style panel: who they are, what they bought, what's in their cart.
    customerProfile: Object,
    cart: Object,
    // The email exactly as it arrived, and the quoted history parsed into messages.
    rawBody: String,
    thread: [{
      name: String, email: String, date: String, text: String, mine: Boolean,
      // Gmail attachment pointers (filename, mimeType, size, attachmentId, messageId).
      attachments: [Object],
    }],
    // Attachments on the newest customer message (same shape as thread[].attachments).
    attachments: [Object],
    sentAt: Date,
    sentBody: String,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// Customer photos, pulled from Gmail by the import workflow and kept here so
// the Inbox can show them without its own Gmail access. One doc per file.
const attachmentSchema = new mongoose.Schema(
  {
    threadId: String,
    messageId: String,
    attachmentId: String,
    filename: String,
    mimeType: String,
    size: Number,
    data: Buffer,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
attachmentSchema.index({ messageId: 1, attachmentId: 1 }, { unique: true });
let Attachment = null;

// Things Dezmond has to do after replying - "ship the Astro Mirror for
// #2713" - shown on the Reminders tab and tied back to the conversation.
const reminderSchema = new mongoose.Schema(
  {
    text: String,
    dueAt: Date,
    leadId: String,
    threadId: String,
    customerName: String,
    email: String,
    orderNumber: String,
    done: { type: Boolean, default: false },
    doneAt: Date,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
let Reminder = null;
const memoryReminders = [];

if (MONGODB_URI) {
  Lead = mongoose.model('Lead', leadSchema);
  Attachment = mongoose.model('Attachment', attachmentSchema);
  Reminder = mongoose.model('Reminder', reminderSchema);
  mongoose
    .connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
    .then(() => {
      dbReady = true;
      dbError = null;
      console.log('MongoDB connected - leads will persist');
      purgeTestLeads();
    })
    .catch((err) => {
      dbError = err.message;
      console.error('MongoDB connection failed, using memory:', err.message);
    });

  mongoose.connection.on('disconnected', () => {
    dbReady = false;
    console.error('MongoDB disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    dbReady = true;
    console.log('MongoDB reconnected');
  });
} else {
  console.warn('MONGODB_URI not set - leads are in memory and reset on restart');
}

// Test traffic (backtests use @example.com senders) never lands in the inbox.
function isTestSender(email) {
  return /@example\.(com|org|net)$/i.test(String(email || '').trim());
}

// One-time clean-up of test leads left over from FAQ backtesting.
async function purgeTestLeads() {
  if (!(dbReady && Lead)) return;
  try {
    const r = await Lead.deleteMany({ email: /@example\.(com|org|net)$/i });
    if (r.deletedCount) console.log(`Removed ${r.deletedCount} test leads`);
  } catch (err) {
    console.error('Test lead purge failed:', err.message);
  }
}

async function saveLead(lead) {
  if (isTestSender(lead.email)) {
    // Return something shaped like a saved lead so backtests still get a reply.
    return { ...lead, _id: 'test-' + Date.now(), notSaved: true };
  }
  if (dbReady && Lead) {
    try {
      const doc = await Lead.create(lead);
      return doc.toObject();
    } catch (err) {
      console.error('Lead save to MongoDB failed, using memory:', err.message);
    }
  }
  const withId = { ...lead, _id: String(nextId++) };
  memoryLeads.unshift(withId);
  if (memoryLeads.length > MAX_LEADS) memoryLeads.pop();
  return withId;
}

// Cheap guess for leads saved before the model started classifying them, and
// a safety net if the model leaves the field out.
const OTHER_PATTERNS = [
  /\b(collab|collaborat|partnership|partner with|sponsor|ambassador|influencer|creator|content creator|ugc|promote your|promo code for my|my audience|my followers|shoutout|brand deal|affiliate)\b/i,
  /\b(seo|backlinks?|guest post|link building|ppc|paid ads|ad campaign|lead generation|marketing agency|digital agency|web design|website redesign|app development|virtual assistant|freelancer|our services|our agency|case stud(y|ies)|book a call|schedule a call|free audit|proposal)\b/i,
  /\b(wholesale (pricing|catalog|supplier)|dropship|private label|manufactur(er|ing) (partner|services)|factory|bulk supplier|packaging solutions|3pl|fulfillment services)\b/i,
  /\b(unsubscribe|view (this|in) browser|newsletter|webinar|limited time offer|exclusive offer for|invoice attached|payment overdue)\b/i,
  /\b(hiring|job opening|resume|cv attached|apply for|internship|position at)\b/i,
];
const CUSTOMER_PATTERNS = [
  /\b(my order|order ?#?\s?\d{3,}|tracking|refund|shipped|shipping|deliver|arrived|package|where is|cancel|address|damaged|broken|missing|wrong (item|size|color|colour)|return|exchange|receipt|confirmation|i (ordered|bought|purchased|paid)|placed an order|how long|when will|in stock|price|size|dimensions|fit)\b/i,
];
function guessAudience(subject, body, from) {
  const text = `${subject || ''}\n${body || ''}`;
  if (CUSTOMER_PATTERNS.some((re) => re.test(text))) return 'customer';
  if (OTHER_PATTERNS.some((re) => re.test(text))) return 'other';
  return 'customer';
}
// Same customer message? Compare the real send time when both sides have it,
// otherwise the opening of the text.
function sameMessage(a, b) {
  const ta = a && a.receivedAt ? new Date(a.receivedAt).getTime() : NaN;
  const tb = b && b.receivedAt ? new Date(b.receivedAt).getTime() : NaN;
  if (!isNaN(ta) && !isNaN(tb)) return Math.abs(ta - tb) < 120000;
  const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
  const qa = norm(a && a.question), qb = norm(b && b.question);
  return Boolean(qa) && qa === qb;
}
function withAudience(lead) {
  if (!lead) return lead;
  if (!lead.audience) lead.audience = guessAudience(lead.subject, lead.question, lead.email);
  return lead;
}

async function listLeads() {
  if (dbReady && Lead) {
    try {
      return (await Lead.find().sort({ createdAt: -1 }).limit(MAX_LEADS).lean()).map(withAudience);
    } catch (err) {
      console.error('Lead read from MongoDB failed:', err.message);
    }
  }
  return memoryLeads.map(withAudience);
}

async function findLead(id) {
  if (dbReady && Lead) {
    try {
      return withAudience(await Lead.findById(id).lean());
    } catch (err) {
      console.error('Lead lookup failed:', err.message);
    }
  }
  return withAudience(memoryLeads.find((l) => l._id === id) || null);
}

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'freemind-5328.myshopify.com';
const SHOPIFY_API_VERSION = '2026-07';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

let cachedShopifyToken = null;
let shopifyTokenExpiresAt = 0;

// Product lookups are cached so repeated questions don't re-hit Shopify.
const productCache = new Map();
const PRODUCT_CACHE_MS = 10 * 60 * 1000;

// Fallback only. Set SUPPORT_FAQ in Render to edit this without touching code.
const BUILTIN_FAQ = `
Q: How long does shipping take?
A: Most of our pieces are handmade to order, so production time varies by item - many mirrors take 12-15 days, wall art 7-18 business days, and premade items like pillows ship in 1-3 days. Delivery is 5-7 business days after production. We ship from Dallas, TX.

Q: Do you offer tracking?
A: Yes, all orders include tracking via the carrier once they ship.

Q: What's your return policy?
A: 30-day returns on most items if unused and in original packaging.

Q: Can I customize sizes/colors?
A: Yes! We offer custom orders. Email support@1cribessential.com with your request.

Q: Do you ship internationally?
A: Currently US only. International coming soon.

Q: What materials do you use?
A: All handmade using premium materials. Details vary by product.

Q: Can I order wholesale?
A: Yes, email support@1cribessential.com for bulk pricing.
`;

// The FAQ lives in SUPPORT_FAQ.txt next to server.js so it can be updated by
// a GitHub commit like everything else. The SUPPORT_FAQ env var still works
// as a fallback if the file is missing; the built-in text is the last resort.
const FAQ_FILE = require('path').join(__dirname, 'SUPPORT_FAQ.txt');
let faqCache = { text: '', mtime: 0 };
function getFaq() {
  try {
    const fs = require('fs');
    const st = fs.statSync(FAQ_FILE);
    if (st.mtimeMs !== faqCache.mtime) {
      faqCache = { text: fs.readFileSync(FAQ_FILE, 'utf8'), mtime: st.mtimeMs };
    }
    if (faqCache.text.trim()) return faqCache.text;
  } catch (e) {
    /* no file - fall through */
  }
  const custom = process.env.SUPPORT_FAQ;
  return custom && custom.trim() ? custom : BUILTIN_FAQ;
}
function faqSource() {
  try { if (require('fs').existsSync(FAQ_FILE)) return 'SUPPORT_FAQ.txt in repo'; } catch (e) { /* ignore */ }
  return process.env.SUPPORT_FAQ ? 'SUPPORT_FAQ env var' : 'built-in fallback';
}

async function getShopifyToken() {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  if (cachedShopifyToken && Date.now() < shopifyTokenExpiresAt) return cachedShopifyToken;
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error('SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are not set');
  }

  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Shopify token request failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }

  cachedShopifyToken = data.access_token;
  shopifyTokenExpiresAt = Date.now() + ((data.expires_in || 86399) - 300) * 1000;
  return cachedShopifyToken;
}

async function shopifyGraphQL(query, variables) {
  const token = await getShopifyToken();
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const json = await res.json().catch(() => ({}));
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors).slice(0, 300)}`);
  }
  return json.data || {};
}

const PRODUCTS_BY_ID_QUERY = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        description
        totalInventory
        priceRangeV2 { minVariantPrice { amount currencyCode } }
        options { name values }
        variants(first: 25) { edges { node { title price } } }
      }
    }
  }`;

function shapeProduct(node) {
  if (!node) return null;
  return {
    id: node.id,
    title: node.title,
    description: String(node.description || '').slice(0, 700),
    price: node.priceRangeV2 && node.priceRangeV2.minVariantPrice
      ? node.priceRangeV2.minVariantPrice.amount
      : null,
    inventory: node.totalInventory,
    options: (node.options || [])
      .map((o) => `${o.name}: ${o.values.join(', ')}`)
      .join(' | '),
    variantPrices: variantPriceList(node),
  };
}

// "3x5 ft $364 | 5x7 ft $849 | 6x9 ft $1310" - so the bot never attaches the
// starting price to the wrong size.
function variantPriceList(node) {
  const edges = (node && node.variants && node.variants.edges) || [];
  const parts = edges
    .map((e) => e.node)
    .filter((v) => v && v.price)
    .map((v) => `${v.title === 'Default Title' ? 'standard' : v.title} $${v.price}`);
  return parts.length > 1 ? parts.join(' | ') : '';
}

// Products are fetched by ID, not by name. A product can be renamed after an
// order is placed - the order still says "iPod Mirror" while the catalog says
// "Phone Mirror" - and a name search silently misses it.
async function getProductsByIds(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))].slice(0, 10);
  if (!unique.length) return [];

  const cacheKey = 'ids:' + unique.slice().sort().join(',');
  const hit = productCache.get(cacheKey);
  if (hit && Date.now() < hit.expires) return hit.value;

  try {
    const data = await shopifyGraphQL(PRODUCTS_BY_ID_QUERY, { ids: unique });
    const items = (data.nodes || []).map(shapeProduct).filter(Boolean);
    productCache.set(cacheKey, { value: items, expires: Date.now() + PRODUCT_CACHE_MS });
    return items;
  } catch (err) {
    console.error('Product fetch by id failed:', err.message);
    return [];
  }
}

const PRODUCT_QUERY = `
  query($q: String!) {
    products(first: 3, query: $q) {
      edges {
        node {
          title
          description
          totalInventory
          priceRangeV2 { minVariantPrice { amount currencyCode } }
          options { name values }
          variants(first: 25) { edges { node { title price } } }
        }
      }
    }
  }`;

async function searchProducts(term) {
  const key = String(term || '').toLowerCase().trim();
  if (!key) return [];

  const hit = productCache.get(key);
  if (hit && Date.now() < hit.expires) return hit.value;

  try {
    const data = await shopifyGraphQL(PRODUCT_QUERY, { q: key });
    const edges = (data.products && data.products.edges) || [];
    const items = edges.map((e) => ({
      title: e.node.title,
      description: String(e.node.description || '').slice(0, 700),
      price: e.node.priceRangeV2 && e.node.priceRangeV2.minVariantPrice
        ? e.node.priceRangeV2.minVariantPrice.amount
        : null,
      inventory: e.node.totalInventory,
      options: (e.node.options || [])
        .map((o) => `${o.name}: ${o.values.join(', ')}`)
        .join(' | '),
      variantPrices: variantPriceList(e.node),
    }));
    productCache.set(key, { value: items, expires: Date.now() + PRODUCT_CACHE_MS });
    return items;
  } catch (err) {
    console.error('Product search failed:', err.message);
    return [];
  }
}

async function gatherProducts(keywords, productIds) {
  // Everything actually on their orders, fetched by product ID.
  const fromOrders = await getProductsByIds(productIds);

  // Anything else they asked about by name that they haven't ordered.
  const covered = new Set(fromOrders.map((p) => p.title.toLowerCase()));
  const extraTerms = [...new Set((keywords || []).map((k) => String(k).trim()).filter(Boolean))]
    .filter((k) => !covered.has(k.toLowerCase()))
    .slice(0, 3);

  const fromKeywords = extraTerms.length
    ? (await Promise.all(extraTerms.map((t) => searchProducts(t)))).flat()
    : [];

  const seen = new Set();
  const merged = [];
  fromOrders.concat(fromKeywords).forEach((p) => {
    const key = p.title.toLowerCase();
    // Free-gift duplicates just muddy the answer.
    if (!seen.has(key) && key.indexOf('free gift') === -1) {
      seen.add(key);
      merged.push(p);
    }
  });

  return merged.slice(0, 8);
}

function formatProducts(products) {
  if (!products || products.length === 0) return '';
  const lines = products.map((p) => {
    const parts = [`- ${p.title}`];
    if (p.variantPrices) parts.push(`  Prices by option: ${p.variantPrices}`);
    else if (p.price) parts.push(`  Price: $${p.price}`);
    if (p.options) parts.push(`  Options: ${p.options}`);
    if (typeof p.inventory === 'number') parts.push(`  Inventory on hand: ${p.inventory}`);
    if (p.description) parts.push(`  Product page says: ${p.description}`);
    return parts.join('\n');
  });
  return `\nRELEVANT PRODUCTS (from the live Shopify catalog). Use these for details the store policies do not cover - dimensions, materials, colour and size options, installation, price, stock. IMPORTANT: a product page here may be out of date. If its production or shipping time disagrees with the STORE POLICIES above, the policies are correct and you must use the policy figure, not the one on this page:\n${lines.join('\n\n')}\n`;
}

const CUSTOMER_QUERY = `
  query($q: String!) {
    customers(first: 1, query: $q) {
      edges {
        node {
          id
          displayName
          firstName
          lastName
          email
          phone
          createdAt
          numberOfOrders
          amountSpent { amount }
          defaultAddress { address1 address2 city provinceCode zip countryCode firstName lastName phone }
          tags
          note
          orders(first: 5, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                legacyResourceId
                createdAt
                shippingAddress { address1 address2 city provinceCode zip countryCode firstName lastName phone }
                displayFinancialStatus
                displayFulfillmentStatus
                totalPriceSet { shopMoney { amount } }
                lineItems(first: 10) { edges { node { title variantTitle quantity unfulfilledQuantity product { id } } } }
                fulfillments(first: 5) {
                  displayStatus
                  createdAt
                  trackingInfo { number url company }
                  fulfillmentLineItems(first: 10) { nodes { quantity lineItem { title } } }
                }
              }
            }
          }
        }
      }
    }
  }`;

// Looks the sender up by email so we find their orders even when they never
// quote an order number - which is most of the time.
async function getCustomerContext(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || clean.indexOf('@') === -1) return null;

  try {
    const data = await shopifyGraphQL(CUSTOMER_QUERY, { q: `email:${clean}` });
    const edge = data.customers && data.customers.edges && data.customers.edges[0];
    if (!edge) return null;
    const c = edge.node;

    return {
      id: c.id,
      name: c.displayName,
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      email: c.email,
      phone: c.phone || null,
      since: c.createdAt || null,
      address: c.defaultAddress || null,
      totalOrders: c.numberOfOrders,
      totalSpent: c.amountSpent ? c.amountSpent.amount : null,
      location: c.defaultAddress
        ? [c.defaultAddress.city, c.defaultAddress.provinceCode, c.defaultAddress.countryCode].filter(Boolean).join(', ')
        : null,
      tags: c.tags || [],
      note: c.note || null,
      orders: (c.orders.edges || []).map((oe) => {
        const o = oe.node;
        const tracking = [];
        (o.fulfillments || []).forEach((f) => {
          (f.trackingInfo || []).forEach((t) => {
            tracking.push({ number: t.number, url: t.url, company: t.company });
          });
        });
        return {
          gid: o.id,
          name: o.name,
          shippingAddress: o.shippingAddress || null,
          adminUrl: o.legacyResourceId
            ? `https://${SHOPIFY_STORE}/admin/orders/${o.legacyResourceId}`
            : null,
          createdAt: o.createdAt,
          financial: o.displayFinancialStatus,
          fulfillment: o.displayFulfillmentStatus,
          total: o.totalPriceSet && o.totalPriceSet.shopMoney ? o.totalPriceSet.shopMoney.amount : null,
          items: (o.lineItems.edges || []).map((le) => ({
            title: le.node.title,
            variant: le.node.variantTitle && le.node.variantTitle !== 'Default Title' ? le.node.variantTitle : null,
            quantity: le.node.quantity,
            unfulfilled: typeof le.node.unfulfilledQuantity === 'number' ? le.node.unfulfilledQuantity : null,
            productId: le.node.product ? le.node.product.id : null,
          })),
          tracking: tracking,
          // One entry per shipment: what went out, when, and its tracking.
          shipments: (o.fulfillments || []).map((f) => ({
            status: f.displayStatus || null,
            createdAt: f.createdAt || null,
            tracking: (f.trackingInfo || []).map((t) => ({ number: t.number, url: t.url, company: t.company })),
            items: ((f.fulfillmentLineItems && f.fulfillmentLineItems.nodes) || []).map((n) => ({
              title: n.lineItem ? n.lineItem.title : '',
              quantity: n.quantity,
            })),
          })),
        };
      }),
    };
  } catch (err) {
    console.error('Customer lookup failed:', err.message);
    return null;
  }
}

// "What's in their cart" - the open (not completed) checkout for this email,
// the same thing Shopify Inbox shows. Dashboard only; the bot never sees it,
// so it can never bring up a cart the customer did not mention.
const CART_QUERY = `
  query($q: String!) {
    abandonedCheckouts(first: 3, query: $q, sortKey: CREATED_AT, reverse: true) {
      nodes {
        updatedAt
        completedAt
        abandonedCheckoutUrl
        totalPriceSet { shopMoney { amount } }
        customer { email }
        lineItems(first: 10) {
          nodes { title variantTitle quantity discountedTotalPriceSet { shopMoney { amount } } }
        }
      }
    }
  }`;

async function getOpenCart(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || clean.indexOf('@') === -1) return null;
  try {
    const data = await shopifyGraphQL(CART_QUERY, { q: `${clean} status:open` });
    const nodes = (data.abandonedCheckouts && data.abandonedCheckouts.nodes) || [];
    const mine = nodes.find(
      (n) => !n.completedAt && n.customer && String(n.customer.email || '').toLowerCase() === clean
    );
    if (!mine) return null;
    return {
      updatedAt: mine.updatedAt,
      url: mine.abandonedCheckoutUrl || null,
      total: mine.totalPriceSet && mine.totalPriceSet.shopMoney ? mine.totalPriceSet.shopMoney.amount : null,
      items: (mine.lineItems.nodes || []).map((li) => ({
        title: li.title,
        variant: li.variantTitle && li.variantTitle !== 'Default Title' ? li.variantTitle : null,
        quantity: li.quantity,
        price: li.discountedTotalPriceSet && li.discountedTotalPriceSet.shopMoney
          ? li.discountedTotalPriceSet.shopMoney.amount : null,
      })),
    };
  } catch (err) {
    console.error('Cart lookup failed:', err.message);
    return null;
  }
}

function formatCustomer(cust) {
  if (!cust) return '';
  const lines = cust.orders.map((o) => {
    const age = daysSince(o.createdAt);
    const parts = [
      `- ${o.name}, placed ${String(o.createdAt).slice(0, 10)}${age !== null ? ` (${age} days ago)` : ''} — ${o.financial}, ${o.fulfillment}, $${o.total}`,
      `  Items: ${o.items.map((i) => `${i.title} x${i.quantity}`).join(', ')}`,
    ];
    parts.push(
      o.tracking.length
        ? `  Tracking: ${o.tracking.map((t) => `${t.company || ''} ${t.number} ${t.url || ''}`.trim()).join('; ')}`
        : '  Tracking: none yet - this order has not shipped'
    );
    return parts.join('\n');
  });

  return `
CUSTOMER RECORD (live from Shopify, matched on their email address):
Name: ${cust.name}
Orders placed with us: ${cust.totalOrders}
Their recent orders, newest first:
${lines.join('\n')}
`;
}

const ORDER_QUERY = `
  query($q: String!) {
    orders(first: 1, query: $q) {
      edges {
        node {
          name
          email
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount } }
          lineItems(first: 20) {
            edges {
              node {
                title
                variantTitle
                quantity
                product { id title }
                originalUnitPriceSet { shopMoney { amount } }
                discountedTotalSet { shopMoney { amount } }
              }
            }
          }
          fulfillments(first: 5) { createdAt trackingInfo { number url company } }
          shippingAddress { city provinceCode countryCode }
        }
      }
    }
  }`;

async function getShopifyOrder(orderNumber) {
  try {
    const raw = String(orderNumber || '').replace(/^#/, '').trim();
    if (!raw) return null;

    const data = await shopifyGraphQL(ORDER_QUERY, { q: `name:#${raw}` });
    const edge = data.orders && data.orders.edges && data.orders.edges[0];
    if (!edge) return null;
    const o = edge.node;

    const tracking = [];
    (o.fulfillments || []).forEach((f) => {
      (f.trackingInfo || []).forEach((t) => {
        tracking.push({
          trackingNumber: t.number || 'N/A',
          trackingUrl: t.url || 'N/A',
          company: t.company || '',
          status: 'shipped',
          shippedAt: f.createdAt ? String(f.createdAt).slice(0, 10) : null,
        });
      });
    });

    return {
      orderNumber: raw,
      orderName: o.name,
      email: String(o.email || '').toLowerCase(),
      status: o.displayFinancialStatus,
      fulfillmentStatus: o.displayFulfillmentStatus,
      createdAt: o.createdAt,
      total: o.totalPriceSet && o.totalPriceSet.shopMoney ? o.totalPriceSet.shopMoney.amount : null,
      products: (o.lineItems.edges || []).map((le) => {
        const orig = le.node.originalUnitPriceSet && le.node.originalUnitPriceSet.shopMoney
          ? Number(le.node.originalUnitPriceSet.shopMoney.amount) : null;
        const paid = le.node.discountedTotalSet && le.node.discountedTotalSet.shopMoney
          ? Number(le.node.discountedTotalSet.shopMoney.amount) : null;
        return {
          name: le.node.title,
          variant: le.node.variantTitle && le.node.variantTitle !== 'Default Title' ? le.node.variantTitle : null,
          quantity: le.node.quantity,
          productId: le.node.product ? le.node.product.id : null,
          freeGift: orig !== null && paid !== null && orig > 0 && paid === 0,
        };
      }),
      trackingInfo: tracking,
      shipTo: o.shippingAddress
        ? [o.shippingAddress.city, o.shippingAddress.provinceCode, o.shippingAddress.countryCode].filter(Boolean).join(', ')
        : null,
    };
  } catch (error) {
    console.error('Shopify order lookup failed:', error.message);
    return null;
  }
}

function daysSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

// ---------------------------------------------------------------------------
// Reply-thread splitting. Gmail sends the whole quoted history under a reply;
// without this the bot answers last week's message instead of today's.
// ---------------------------------------------------------------------------
// Splits an email body into the customer's NEW message and the quoted history
// underneath it, then breaks the history into individual messages so the
// dashboard can show a conversation instead of a wall of ">" lines.

const HEADER_RE = /^On .{3,200}?wrote:\s*$/;

function normalizeLines(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n');
}

// Gmail wraps long "On <date> <name> <email>" headers onto a second line that
// just says "wrote:". Join those so each header is one line.
function joinWrappedHeaders(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^On .{3,200}$/.test(line) && !/wrote:\s*$/.test(line)) {
      // Look ahead up to two lines for the rest of the header.
      let joined = line.trim();
      let used = 0;
      for (let k = 1; k <= 2 && i + k < lines.length; k++) {
        joined += ' ' + lines[i + k].trim();
        used = k;
        if (/wrote:\s*$/.test(joined)) break;
      }
      if (/wrote:\s*$/.test(joined) && joined.length < 260) {
        out.push(joined.replace(/<\s+/, '<').replace(/\s+>/, '>'));
        i += used;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

function isCutLine(line) {
  const t = line.trim();
  if (t.startsWith('>')) return true;
  if (HEADER_RE.test(t)) return true;
  if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(t)) return true;
  if (/^-{2,}\s*Forwarded message\s*-{2,}$/i.test(t)) return true;
  if (/^_{10,}$/.test(t)) return true;
  return false;
}

function splitQuoted(body) {
  const lines = joinWrappedHeaders(normalizeLines(body));
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isCutLine(lines[i])) {
      // "From: x\nSent: y" Outlook style is handled by the underscore rule
      // above; here we only need the first quote marker.
      cut = i;
      break;
    }
    // Outlook: "From: Name <email>" followed shortly by "Sent:"/"Date:"
    if (/^From:\s/.test(lines[i]) && lines.slice(i + 1, i + 4).some((l) => /^(Sent|Date):\s/.test(l))) {
      cut = i;
      break;
    }
  }
  if (cut === -1) {
    return { newText: lines.join('\n').trim(), history: '', thread: [] };
  }
  const newText = lines.slice(0, cut).join('\n').trim();
  const historyLines = lines.slice(cut);
  const history = historyLines.join('\n').trim();
  return { newText, history, thread: parseHistory(historyLines) };
}

function stripQuoteMarks(line) {
  return line.replace(/^(\s*>)+\s?/, '');
}

// Mobile mail apps tack "Sent from my iPhone" onto the end - sometimes on the
// same line as the last sentence - and our own replies carry the store
// signature. Neither is part of what anyone said.
function stripSignatures(text) {
  let t = String(text || '').replace(/\r\n?/g, '\n');
  t = t
    .split('\n')
    .filter((line) => !/^\s*(sent from (my|yahoo)|get outlook for|sent via)\b/i.test(line))
    .join('\n');
  let prev;
  do {
    prev = t;
    t = t.replace(/[\s ]*sent from my \w+[^\n]*$/i, '').trimEnd();
  } while (t !== prev);
  t = t.replace(/(\n\s*)*(crib essentials|@1cribessentials)\s*$/i, '');
  t = t.replace(/(\n\s*)*(crib essentials|@1cribessentials)\s*$/i, '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// Gmail attachment pointers as sent by the import workflow. The bytes live in
// the Attachment collection; these are just enough to find and label them.
function shapeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10).map((a) => ({
    filename: String(a.filename || ''), mimeType: String(a.mimeType || ''),
    size: Number(a.size) || 0, attachmentId: String(a.attachmentId || ''), messageId: String(a.messageId || ''),
  })).filter((a) => a.attachmentId && a.messageId);
}

function parseHeader(line) {
  // "On Sat, Aug 29, 2026 at 11:01 AM Davaughn Paige <x@y.com> wrote:"
  let rest = line.replace(/^On\s+/, '').replace(/\s*wrote:\s*$/, '');
  let email = '';
  const em = rest.match(/<([^>]+)>/);
  if (em) {
    email = em[1].trim().toLowerCase();
    rest = rest.replace(em[0], '').trim();
  }
  // Date runs up to the time (or the year if there is no time); name is the rest.
  const dm = rest.match(/^(.*?\d{1,2}:\d{2}\s?(?:AM|PM)?),?\s+(.+)$/i) || rest.match(/^(.*?\d{4}),?\s+(.+)$/);
  const date = dm ? dm[1].trim() : rest;
  const name = dm ? dm[2].trim() : '';
  return { date, name, email };
}

function parseHistory(historyLines) {
  const cleaned = joinWrappedHeaders(historyLines.map(stripQuoteMarks));
  const messages = [];
  let current = null;
  cleaned.forEach((line) => {
    const t = line.trim();
    if (HEADER_RE.test(t)) {
      if (current) messages.push(current);
      const h = parseHeader(t) || { date: '', name: '', email: '' };
      current = { ...h, lines: [] };
      return;
    }
    if (!current) {
      // Text before the first header (e.g. Outlook-style) - keep as unknown.
      current = { date: '', name: '', email: '', lines: [] };
    }
    current.lines.push(line);
  });
  if (current) messages.push(current);

  return messages
    .map((m) => {
      let text = m.lines.join('\n')
        .replace(/<https?:\/\/www\.google\.com\/maps[^>]*>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      // Drop the store's own signature block from its messages.
      text = text.replace(/\n*Crib Essentials\s*\n@1cribessentials\s*$/i, '').trim();
      const mine = /1cribessential/i.test(m.email) || /^crib essentials$/i.test(m.name);
      return { name: m.name, email: m.email, date: m.date, text, mine };
    })
    .filter((m) => m.text);
}


async function askClaude(email, faqContext, shopifyData, productBlock, customerBlock, extra) {
  extra = extra || {};
  const today = new Date().toISOString().slice(0, 10);
  let orderBlock = '';
  if (extra.orderMismatch) {
    orderBlock = `
ORDER NUMBER CHECK: the customer quoted order ${extra.orderMismatch}, but that order is not under the email address they wrote from. Do NOT reveal anything about that order - no status, no items, no tracking. Say you are pulling up order ${extra.orderMismatch} and will come right back, and set needsHuman to true so Dezmond can verify it is theirs.
`;
  }
  if (shopifyData && !extra.orderMismatch) {
    const age = daysSince(shopifyData.createdAt);
    orderBlock = `
CUSTOMER ORDER (live from Shopify):
Order: ${shopifyData.orderName || shopifyData.orderNumber}
Placed: ${String(shopifyData.createdAt).slice(0, 10)}${age !== null ? ` (${age} days ago)` : ''} - this is the date the ORDER was placed, NOT the date it shipped. Never call this the ship date.
Payment status: ${shopifyData.status}
Fulfillment status: ${shopifyData.fulfillmentStatus || 'unfulfilled'}
Items on this order (the order cannot ship before its slowest item - each item's production time is on its product page below):
${shopifyData.products.map((p) => `  - ${p.name} (qty ${p.quantity})${p.freeGift ? ' - FREE GIFT, $0, added automatically' : ''}`).join('\n')}
Tracking: ${
      shopifyData.trackingInfo.length
        ? shopifyData.trackingInfo
            .map((t) => `${t.company ? t.company + ' ' : ''}${t.trackingNumber}${t.shippedAt ? ` - shipped on ${t.shippedAt}` : ''} ${t.trackingUrl}`)
            .join('; ')
        : 'not shipped yet - no tracking'
    }
`;
  }

  const prompt = `You are a customer support agent for Crib Essentials, a handmade home decor brand in Dallas, TX selling wall art, mirrors, rugs, pillows and decorative pieces.

TODAY'S DATE: ${today}

EMAIL SUBJECT LINE: "${extra.subject || ''}"
(An order number in the subject line counts exactly like one in the body - e.g. "Re: Order #2715 confirmed" means they are asking about order 2715.)
${extra.customerName ? `THE CUSTOMER WROTE AS: "${extra.customerName}". If you greet them by name, use the first name from THIS, not the name on the Shopify account (the account can be under a partner's or parent's name). If it looks like a nickname or handle rather than a name, skip the greeting name entirely.` : ''}

CUSTOMER'S NEW MESSAGE (this is what you are replying to - answer THIS):
"${email}"
${extra.attachments && extra.attachments.length ? `(They attached ${extra.attachments.length} file${extra.attachments.length === 1 ? '' : 's'}: ${extra.attachments.map((a) => a.filename).join(', ')}. You cannot see the files. If they are photos of a problem, thank them for the photos and say the team is looking at them - never describe what the photos show, and if the policies ask for photos, do not ask for them again.)` : ''}
${extra.history ? `
EARLIER MESSAGES IN THIS THREAD (quoted history, oldest at the bottom). Context only. These were already dealt with - do NOT answer them again and do NOT confirm or repeat things from them. Use them only to understand what the new message refers to (which order, which address, what was already promised):
<<<
${extra.history}
>>>
` : ''}
STORE POLICIES AND CURRENT NOTICES:
${faqContext}
${customerBlock || ''}${orderBlock}${productBlock}

RULES:
- Most items are handmade to order. Never promise a delivery date faster than the stated production time.
- WHICH SOURCE TO BELIEVE, in this order, highest first:
  1. CURRENT NOTICES in the policies - these are written today and beat everything else.
  2. The rest of the STORE POLICIES above - these are kept up to date by hand.
  3. A product page description - use it only for details the policies do not cover, such as dimensions, materials or installation.
  If the policies and a product page disagree on a production time, the policies are right and the product page is out of date. Never quote a product page timeline that contradicts the policies.
- Never guess an item's timeline from a similar-sounding product. If neither the policies nor its product page covers it, do not state a timeline at all.
- An order ships no sooner than its SLOWEST item unless the policies say items ship as they are ready. Identify the slowest item and lead with its timeline; never imply the order is nearly ready because the quick items are.
- Never state where a specific parcel or item currently is unless live order data is shown above. Without it, describe what usually happens and ask for the order number.
- If a notice above mentions a delay or a temporary change, reflect it in your answer.
- Use the customer record above to work out which order they mean, even if they never gave an order number. Refer to orders by number so there is no confusion.
- If they have more than one order, address each one they are asking about separately and say plainly which has shipped and which has not.
- Never say an order has shipped unless its fulfillment status says so, and never invent tracking numbers, dates, prices or stock levels.
- If they are asking you to CHANGE something - a shipping address, a cancellation, a refund, swapping an item - you cannot do it. Say a human will take care of it and confirm shortly. Never imply the change has been made. If an order they want changed has already shipped, say so honestly.
- If they are a repeat customer, a brief word of thanks is welcome, but do not overdo it.
- Never write the name "Dezmond" or any staff name in the reply. Speak as the brand: "we", "us", "our team", "I". Any mention of Dezmond in these instructions is about the internal flag, never something to tell the customer.
- Warm, brief, 2-5 sentences. Write as a real person at the brand, not a bot.

Respond with ONLY raw JSON, no markdown fences:
{
  "type": "order_inquiry" | "product_question" | "general_support",
  "summary": "one or two short lines: what the whole conversation is about so far and what the customer needs from us now",
  "response": "the reply to send",
  "extractedOrderNumber": "order number if mentioned in the body OR the subject line, else null",
  "productKeywords": ["product names or types mentioned, else empty array"],
  "needsHuman": true or false,
  "flagReason": "if needsHuman is true, a few words on what Dezmond needs to do; else null",
  "audience": "customer" | "other"
}

audience is "customer" for anyone who has bought, is asking about an order, or is asking about buying - even if they are angry or vague. audience is "other" for everything that is not a customer: vendors, agencies and freelancers pitching services (marketing, SEO, ads, packaging, manufacturing, software, web design), influencer / creator / collab / partnership requests, job seekers, wholesale and reseller pitches from businesses, newsletters and marketing blasts, cold outreach, spam, and automated notifications. If someone pitches a service AND asks about buying, they are "customer".

Set needsHuman to true whenever the STORE POLICIES say to flag the email for Dezmond, whenever your reply says you will check on something and come back, whenever the customer is asking for a change you cannot make (address, cancellation, refund, swap, expedite), and whenever the email is a threat, a legal notice, a partnership or vendor pitch, or something the policies do not cover. When the reply is complete and needs nothing from Dezmond, set it to false.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  });

  let text = message.content[0].text.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();

  try {
    const orderText = `${customerBlock || ''}${orderBlock}`;
    const unshipped = !orderText.trim() || /not shipped|unfulfilled|partially/i.test(orderText);
    return polishReply(JSON.parse(text), { unshipped });
  } catch (e) {
    return {
      type: 'general_support',
      summary: 'Could not parse AI response',
      response: text,
      extractedOrderNumber: null,
      productKeywords: [],
      needsHuman: true,
      flagReason: 'AI reply could not be parsed - read before sending',
    };
  }
}

// Last line of defence after the model answers. Two jobs:
//  1. The sign-off is not optional, so add it when the model forgot.
//  2. Catch the guesses the backtest kept finding - "arriving any day now",
//     "on their way" for an unmade piece, invented refund timing - and make
//     sure a human reads that reply before it goes anywhere.
const GUESS_PATTERNS = [
  [/\b(any day now|arriv(e|es|ing) (soon|shortly|any day|before long)|should (arrive|be there|be arriving|be with you|land|show up|be delivered)|(should|will|'ll|gonna|going to) (see|get|have|receive) (it|them|those|that|yours?|your \w+( \w+)?) (soon|shortly|any day|before long|in no time)|just around the corner|won'?t be (much )?long|(be|get) there (soon|shortly)|coming (very )?soon|soon enough|in no time)\b/i, 'guesses at an arrival date'],
  [/\b(on (its|their|the) way|still coming|in transit|heading (to|your way)|will follow shortly|will arrive on (its|their) own)\b/i, 'says something is "on the way" - confirm it has actually shipped'],
  [/\b(process(ing|ed)?|issu(e|ed|ing)|approv(e|ed|ing)|send(ing)?|sent|initiat(e|ed|ing)|start(ed|ing)?) (the|your|a|this) (full |partial )?refund\b|\brefund (is|has been|will be|was) (processed|issued|approved|on its way|sent|coming)|\brefund(ed|ing) (you|it|your)\b/i, 'promises a refund - only Dezmond decides that'],
  [/\b(refund|money|funds|credit)\b[^.]{0,80}\b\d+\s*(-|to)\s*\d+\s*(business\s+)?days\b/i, 'states a refund timeline'],
  [/\b\d+\s*(-|to)\s*\d+\s*(business\s+)?days\b[^.]{0,80}\b(refund|back on your card|returned to)\b/i, 'states a refund timeline'],
  [/\b(you('?re| are) all set|all taken care of|(has|have) been (updated|changed|cancell?ed|removed|swapped)|is (now )?(updated|changed|cancell?ed)|(updated|changed|cancell?ed) (it|that|your (order|address)) for you|don'?t worry|no need to worry|nothing to worry about)\b/i, 'says a change is already done or promises the outcome'],
  [/\bdezmond\b/i, 'names a staff member'],
];

function polishReply(parsed, ctx) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const unshipped = !ctx || ctx.unshipped !== false;
  let reply = String(parsed.response || '').trim();
  if (reply) {
    // Normalise any near-miss sign-off, then make sure exactly one is there.
    const signoff = /\n*\s*[-–—]?\s*(the\s+)?crib essentials(\s+team)?\s*[.!]?\s*$/i;
    let before = null;
    while (before !== reply) { before = reply; reply = reply.replace(signoff, '').trim(); }
    reply = `${reply}\n\n- Crib Essentials`;
  }
  parsed.response = reply;

  const body = reply.replace(/- Crib Essentials\s*$/, '');
  const hits = [];
  for (const [re, why] of GUESS_PATTERNS) {
    // "On the way" is only a guess when something is still unshipped (or we
    // have no order in front of us at all).
    if (/on the way/.test(why) && !unshipped) continue;
    if (re.test(body) && !hits.includes(why)) hits.push(why);
  }
  if (hits.length) {
    parsed.needsHuman = true;
    const note = `Read before sending - reply ${hits.join('; ')}.`;
    parsed.flagReason = parsed.flagReason ? `${parsed.flagReason} ${note}` : note;
  }
  return parsed;
}

// Turn the one vetted reply into three tones Dezmond can pick from. This is a
// rewrite only: the model may rephrase, expand or tighten, but it is told it
// may not add a single fact, number, promise or policy that is not already in
// the original. The original is always drafts[0] so there is a safe fallback.
async function makeDraftVariants(original, customerEmail) {
  const base = [{ tone: 'short', label: 'Short & warm', text: original }];
  if (!original || !String(original).trim()) return base;

  const prompt = `You are rewriting a customer support reply for Crib Essentials, a small handmade home decor brand in Dallas. Below is the APPROVED reply. Produce two rewrites of it in different tones.

STRICT RULES:
- Rewrite only. Every rewrite must say the same things as the approved reply - same facts, same numbers, same dates, same requests (for an order number, for photos, etc.), same "I'll check and come back" promises.
- Do NOT add any fact, number, timeline, price, policy, product name, apology for something not mentioned, or promise that is not in the approved reply. Do not remove a request the approved reply makes.
- Do NOT do arithmetic on the approved reply's numbers: never add production and delivery times together, never convert business days into weeks, never say "roughly", "about", "in total", "all in", or "from order to arrival" with a new figure. Quote each number exactly as the approved reply states it, once.
- Do NOT add reassurance the approved reply does not contain ("worth the wait", "you'll love it", "don't worry", "rest assured").
- Do not say "I'm a real person", do not mention AI, never name any staff member (no "Dezmond"), and never use internal language ("the system", "our records", "flagging", "escalating").
- Write in the same language the approved reply is written in.
- Use the customer's name only if the approved reply uses it.
- Each rewrite must end with "- Crib Essentials" on its own line, with a blank line before it. Nothing after it.

TONES:
1. "detailed": a little longer and more thorough - explain the why behind each point in a friendly way, still human and warm, 4-7 sentences. No new facts, just fuller sentences.
2. "formal": polished and professional, apologetic where the approved reply apologizes, no slang, no exclamation marks, 3-6 sentences.

CUSTOMER'S EMAIL (for context only - do not answer anything the approved reply does not answer):
"""
${customerEmail}
"""

APPROVED REPLY:
"""
${original}
"""

Respond with ONLY this JSON, no markdown:
{"detailed": "...", "formal": "..."}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });
    let text = message.content[0].text.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(text);
    const out = base.slice();
    if (parsed.detailed && String(parsed.detailed).trim()) {
      out.push({ tone: 'detailed', label: 'Detailed', text: String(parsed.detailed).trim() });
    }
    if (parsed.formal && String(parsed.formal).trim()) {
      out.push({ tone: 'formal', label: 'Formal', text: String(parsed.formal).trim() });
    }
    return out;
  } catch (err) {
    console.error('Draft variants failed, keeping the single draft:', err.message);
    return base;
  }
}

app.post('/api/process-email', async (req, res) => {
  try {
    const { from, customerName, body: rawBody, subject, threadId, faqContext, quiet, replace } = req.body;
    // When the customer actually sent it (Gmail's Date header, passed by the
    // workflow). Falls back to now for anything that arrives without it.
    const receivedRaw = req.body.receivedAt ? new Date(req.body.receivedAt) : null;
    const receivedAt = receivedRaw && !isNaN(receivedRaw.getTime()) ? receivedRaw : new Date();
    if (!rawBody) return res.status(400).json({ error: 'Missing body in request' });

    // Only the new message is "the email"; the quoted history rides along as context.
    const split = splitQuoted(rawBody);
    const body = stripSignatures(split.newText) || stripSignatures(rawBody) || String(rawBody).trim();
    let history = split.history ? split.history.slice(0, 4000) : '';

    // A caller that already has the whole Gmail thread (the backfill, or the
    // Zap once it fetches threads) can pass it as `thread`: newest first, each
    // { name, email, date, text, mine }. It replaces the quoted-text parse.
    let threadMsgs = split.thread;
    const latestAttachments = shapeAttachments(req.body.attachments);
    if (Array.isArray(req.body.thread) && req.body.thread.length) {
      threadMsgs = req.body.thread
        .map((m) => ({
          name: String(m.name || ''), email: String(m.email || '').toLowerCase(), date: String(m.date || ''),
          text: stripSignatures(m.text), mine: Boolean(m.mine),
          attachments: shapeAttachments(m.attachments),
        }))
        .filter((m) => m.text || m.attachments.length);
      history = threadMsgs
        .map((m) => `${m.mine ? 'CRIB ESSENTIALS' : (m.name || m.email || 'CUSTOMER')} (${m.date}):\n${m.text}`)
        .join('\n\n---\n\n')
        .slice(0, 6000);
    }

    const faq = faqContext && String(faqContext).trim() ? faqContext : getFaq();

    // Look the sender up by email first - most people never quote an order number.
    const [customer, cart] = await Promise.all([getCustomerContext(from), getOpenCart(from)]);
    const customerBlock = formatCustomer(customer);

    // Pass 1: understand the email and pull out the order number / product hints.
    const initial = await askClaude(body, faq, null, '', customerBlock, { subject, history, customerName, attachments: latestAttachments });

    let shopifyData = null;
    let orderMismatch = null;
    if (initial.extractedOrderNumber) {
      shopifyData = await getShopifyOrder(initial.extractedOrderNumber);
    }

    // Privacy: only show an order to the person it belongs to. Anyone can type
    // a number into an email; the order's own email (or the sender's customer
    // record) has to match before we reveal items or tracking.
    if (shopifyData) {
      const sender = String(from || '').trim().toLowerCase();
      const ownsByEmail = shopifyData.email && sender && shopifyData.email === sender;
      const ownsByRecord = customer && (customer.orders || []).some(
        (o) => String(o.name).replace(/^#/, '') === String(shopifyData.orderNumber)
      );
      if (!ownsByEmail && !ownsByRecord) {
        orderMismatch = shopifyData.orderNumber;
        shopifyData = null;
      }
    }

    const orderProductIds = shopifyData
      ? shopifyData.products.map((p) => p.productId)
      : [];
    const customerProductIds = customer
      ? customer.orders.reduce(
          (acc, o) => acc.concat(o.items.map((i) => i.productId)),
          []
        )
      : [];

    const products = await gatherProducts(
      initial.productKeywords,
      orderProductIds.concat(customerProductIds)
    );

    // Pass 2: answer again, now with the real order and product data in hand.
    const needsSecondPass = Boolean(shopifyData) || products.length > 0;
    const final = needsSecondPass || orderMismatch
      ? await askClaude(body, faq, shopifyData, formatProducts(products), customerBlock, { subject, orderMismatch, history, customerName, attachments: latestAttachments })
      : initial;

    const needsHuman = Boolean(final.needsHuman) || Boolean(orderMismatch);
    const flagReason = orderMismatch
      ? `Customer quoted order ${orderMismatch} but it is not under their email - verify before sharing anything`
      : (final.flagReason || null);

    // Three tones of the same vetted reply for the dashboard picker.
    const drafts = await makeDraftVariants(final.response, body);

    const leadDoc = {
      email: from,
      customerName,
      question: body,
      orderNumber: final.extractedOrderNumber || initial.extractedOrderNumber || null,
      productType: final.type,
      shopifyOrderData: shopifyData,
      matchedProducts: products.map((p) => p.title),
      customerOrders: customer
        ? customer.orders.map((o) => `${o.name} (${o.fulfillment}, $${o.total})`)
        : [],
      customerTotalOrders: customer ? customer.totalOrders : null,
      aiAnalysis: final.summary,
      aiResponse: final.response,
      threadId: threadId || null,
      subject: subject || null,
      receivedAt,
      status: 'drafted',
      needsHuman: needsHuman,
      flagReason: flagReason,
      audience: (final.audience === 'other' || initial.audience === 'other') ? 'other'
        : (final.audience === 'customer' ? 'customer' : guessAudience(subject, body, from)),
      drafts: drafts,
      rawBody: String(rawBody),
      thread: threadMsgs,
      attachments: latestAttachments,
      customerProfile: customer
        ? {
            id: customer.id, name: customer.name, firstName: customer.firstName, lastName: customer.lastName,
            email: customer.email, phone: customer.phone, since: customer.since, address: customer.address,
            totalOrders: customer.totalOrders, totalSpent: customer.totalSpent, location: customer.location,
            tags: customer.tags, note: customer.note, orders: customer.orders,
          }
        : null,
      cart: cart,
      createdAt: new Date(),
    };

    // Re-processing the same thread (backfill re-runs) replaces the unsent
    // draft instead of stacking a duplicate conversation in the inbox.
    let saved = null;
    if (replace && threadId && dbReady && Lead && !isTestSender(from)) {
      try {
        const all = await Lead.find({ threadId }).sort({ createdAt: -1 });
        const answered = all.find((l) => l.status === 'sent' && sameMessage(l, leadDoc));
        if (answered) {
          // Dezmond already replied to this exact message. Refresh the context
          // (thread, photos, real date, customer data) but leave his reply and
          // the sent status alone - and drop any unsent copies of the same
          // message so the conversation does not reopen.
          const patch = {
            thread: leadDoc.thread, attachments: leadDoc.attachments, receivedAt: leadDoc.receivedAt,
            customerProfile: leadDoc.customerProfile, cart: leadDoc.cart, customerOrders: leadDoc.customerOrders,
            customerTotalOrders: leadDoc.customerTotalOrders, shopifyOrderData: leadDoc.shopifyOrderData,
            aiAnalysis: leadDoc.aiAnalysis, subject: leadDoc.subject, customerName: leadDoc.customerName,
            orderNumber: leadDoc.orderNumber || answered.orderNumber,
          };
          if (answered.audienceSetBy !== 'dashboard') patch.audience = leadDoc.audience;
          await Lead.findByIdAndUpdate(answered._id, patch);
          const dupes = all.filter((l) => l.status !== 'sent' && sameMessage(l, leadDoc)).map((l) => l._id);
          if (dupes.length) await Lead.deleteMany({ _id: { $in: dupes } });
          saved = await Lead.findById(answered._id).lean();
        } else {
          const existing = all.find((l) => l.status !== 'sent');
          if (existing) {
            delete leadDoc.createdAt;
            // A bucket Dezmond chose by hand beats the model's guess.
            if (existing.audienceSetBy === 'dashboard' && existing.audience) leadDoc.audience = existing.audience;
            await Lead.findByIdAndUpdate(existing._id, leadDoc);
            saved = await Lead.findById(existing._id).lean();
          }
        }
      } catch (err) {
        console.error('Replace-by-thread failed, saving fresh:', err.message);
      }
    }
    if (!saved) saved = await saveLead(leadDoc);

    if (quiet) {
      return res.json({ success: true, id: saved._id, needsHuman, flagReason, replaced: Boolean(replace && saved && saved.createdAt && leadDoc.createdAt === undefined), reply: final.response });
    }
    res.json({ success: true, lead: saved, response: final.response, drafts: drafts });
  } catch (error) {
    console.error('Error processing email:', error);
    res.status(500).json({ error: error.message });
  }
});

// Customer emails are private, so reading leads needs the same dashboard
// token as sending. (If DASHBOARD_TOKEN is not set, reading stays open so the
// dashboard still works while you set things up.)
function readGate(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return true;
  const supplied = req.get('x-dashboard-token') || req.query.token || '';
  if (supplied !== token) {
    res.status(401).json({ error: 'Dashboard token required.' });
    return false;
  }
  return true;
}

app.get('/api/leads', async (req, res) => {
  if (!readGate(req, res)) return;
  try {
    res.json(await listLeads());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads/:id', async (req, res) => {
  if (!readGate(req, res)) return;
  try {
    const lead = await findLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const SEND_WEBHOOK_URL = process.env.SEND_WEBHOOK_URL;
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;

// Sending mail is the one action here with real-world consequences, so it is
// gated on a shared token. Without DASHBOARD_TOKEN set, the route is disabled
// entirely rather than left open.
function checkToken(req, res) {
  if (!DASHBOARD_TOKEN) {
    res.status(503).json({ error: 'Sending is disabled: DASHBOARD_TOKEN is not set on the server.' });
    return false;
  }
  const supplied = req.get('x-dashboard-token') || '';
  if (supplied !== DASHBOARD_TOKEN) {
    res.status(401).json({ error: 'Bad or missing dashboard token.' });
    return false;
  }
  return true;
}

app.post('/api/leads/:id/send', async (req, res) => {
  if (!checkToken(req, res)) return;

  try {
    if (!SEND_WEBHOOK_URL) {
      return res.status(503).json({ error: 'SEND_WEBHOOK_URL is not set on the server.' });
    }

    const lead = await findLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const bodyText = String((req.body && req.body.body) || '').trim();
    if (!bodyText) return res.status(400).json({ error: 'Reply body is empty' });
    if (!lead.threadId) {
      return res.status(400).json({ error: 'This lead has no Gmail thread id, so it cannot be replied to in thread.' });
    }

    const hook = await fetch(SEND_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: lead.threadId,
        to: lead.email,
        subject: lead.subject ? `Re: ${lead.subject}` : undefined,
        body: bodyText,
      }),
    });

    if (!hook.ok) {
      const t = await hook.text().catch(() => '');
      return res.status(502).json({ error: `Send webhook returned ${hook.status}: ${t.slice(0, 200)}` });
    }

    const sentAt = new Date();
    if (dbReady && Lead) {
      await Lead.findByIdAndUpdate(req.params.id, {
        status: 'sent',
        sentAt: sentAt,
        sentBody: bodyText,
      });
    } else {
      const m = memoryLeads.find((l) => l._id === req.params.id);
      if (m) {
        m.status = 'sent';
        m.sentAt = sentAt;
        m.sentBody = bodyText;
      }
    }

    res.json({ sent: true, sentAt });
  } catch (err) {
    console.error('Send failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Older leads were saved before tone options existed. The dashboard calls
// this once for such a lead and the three drafts get generated and stored.
app.post('/api/leads/:id/drafts', async (req, res) => {
  if (!checkToken(req, res)) return;
  try {
    const lead = await findLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const existing = Array.isArray(lead.drafts) ? lead.drafts.filter((d) => d && d.text) : [];
    if (existing.length > 1) return res.json({ ok: true, drafts: existing });
    const drafts = await makeDraftVariants(lead.aiResponse || '', lead.question || '');
    if (dbReady && Lead) {
      await Lead.findByIdAndUpdate(req.params.id, { drafts });
    } else {
      const m = memoryLeads.find((l) => l._id === req.params.id);
      if (m) m.drafts = drafts;
    }
    res.json({ ok: true, drafts });
  } catch (err) {
    console.error('Draft generation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Dezmond moves a conversation between the customer list and "Other".
app.post('/api/leads/:id/audience', async (req, res) => {
  if (!checkToken(req, res)) return;
  const audience = req.body && req.body.audience === 'other' ? 'other' : 'customer';
  try {
    if (dbReady && Lead) {
      const updated = await Lead.findByIdAndUpdate(req.params.id, { audience, audienceSetBy: 'dashboard' }, { new: true }).lean();
      if (!updated) return res.status(404).json({ error: 'Not found' });
    } else {
      const m = memoryLeads.find((l) => l._id === req.params.id);
      if (!m) return res.status(404).json({ error: 'Not found' });
      m.audience = audience; m.audienceSetBy = 'dashboard';
    }
    res.json({ ok: true, audience });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Reminders ----
function cleanReminder(body) {
  const text = String((body && body.text) || '').trim().slice(0, 300);
  const due = body && body.dueAt ? new Date(body.dueAt) : null;
  return {
    text,
    dueAt: due && !isNaN(due.getTime()) ? due : null,
    leadId: body && body.leadId ? String(body.leadId) : null,
    threadId: body && body.threadId ? String(body.threadId) : null,
    customerName: body && body.customerName ? String(body.customerName).slice(0, 120) : null,
    email: body && body.email ? String(body.email).slice(0, 200) : null,
    orderNumber: body && body.orderNumber ? String(body.orderNumber).slice(0, 40) : null,
  };
}

app.get('/api/reminders', async (req, res) => {
  if (!readGate(req, res)) return;
  try {
    if (dbReady && Reminder) {
      return res.json(await Reminder.find().sort({ done: 1, dueAt: 1, createdAt: -1 }).limit(500).lean());
    }
    res.json(memoryReminders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reminders', async (req, res) => {
  if (!checkToken(req, res)) return;
  const r = cleanReminder(req.body);
  if (!r.text) return res.status(400).json({ error: 'Reminder text is required.' });
  try {
    if (dbReady && Reminder) {
      const doc = await Reminder.create(r);
      return res.json({ ok: true, reminder: doc.toObject() });
    }
    const withId = { ...r, _id: 'r' + Date.now(), done: false, createdAt: new Date() };
    memoryReminders.unshift(withId);
    res.json({ ok: true, reminder: withId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One route for edits, ticking off, un-ticking and deleting - keeps the
// dashboard code small.
app.post('/api/reminders/:id', async (req, res) => {
  if (!checkToken(req, res)) return;
  const b = req.body || {};
  try {
    if (b.action === 'delete') {
      if (dbReady && Reminder) await Reminder.findByIdAndDelete(req.params.id);
      else {
        const i = memoryReminders.findIndex((x) => x._id === req.params.id);
        if (i >= 0) memoryReminders.splice(i, 1);
      }
      return res.json({ ok: true, deleted: true });
    }
    const patch = {};
    if (b.action === 'done') { patch.done = true; patch.doneAt = new Date(); }
    if (b.action === 'undo') { patch.done = false; patch.doneAt = null; }
    if (typeof b.text === 'string' && b.text.trim()) patch.text = b.text.trim().slice(0, 300);
    if (b.dueAt !== undefined) {
      const d = b.dueAt ? new Date(b.dueAt) : null;
      patch.dueAt = d && !isNaN(d.getTime()) ? d : null;
    }
    if (dbReady && Reminder) {
      const doc = await Reminder.findByIdAndUpdate(req.params.id, patch, { new: true }).lean();
      if (!doc) return res.status(404).json({ error: 'Not found' });
      return res.json({ ok: true, reminder: doc });
    }
    const m = memoryReminders.find((x) => x._id === req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    Object.assign(m, patch);
    res.json({ ok: true, reminder: m });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/product-check', async (req, res) => {
  const term = req.query.q || 'mirror';
  const out = { term };

  try {
    const token = await getShopifyToken();
    const scopeRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/oauth/access_scopes.json`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    const scopeBody = await scopeRes.json().catch(() => ({}));
    out.grantedScopes = (scopeBody.access_scopes || []).map((s) => s.handle);
  } catch (err) {
    out.scopeError = err.message;
  }

  try {
    const data = await shopifyGraphQL(PRODUCT_QUERY, { q: term });
    const edges = (data.products && data.products.edges) || [];
    out.count = edges.length;
    out.products = edges.map((e) => e.node.title);
  } catch (err) {
    out.productError = err.message;
  }

  res.json(out);
});

app.get('/api/customer-check', async (req, res) => {
  if (!readGate(req, res)) return;
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Pass ?email=someone@example.com' });
    const c = await getCustomerContext(email);
    res.json({ ok: true, found: Boolean(c), customer: c });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Live Shopify panel for the dashboard: profile + open cart for an email.
// Used for leads saved before this existed, and to refresh stale ones.
app.get('/api/customer', async (req, res) => {
  if (!readGate(req, res)) return;
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Pass ?email=' });
    const [customer, cart] = await Promise.all([getCustomerContext(email), getOpenCart(email)]);
    res.json({
      ok: true,
      profile: customer
        ? {
            id: customer.id, name: customer.name, firstName: customer.firstName, lastName: customer.lastName,
            email: customer.email, phone: customer.phone, since: customer.since, address: customer.address,
            totalOrders: customer.totalOrders, totalSpent: customer.totalSpent, location: customer.location,
            tags: customer.tags, note: customer.note, orders: customer.orders,
          }
        : null,
      cart: cart,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Edits from the dashboard. These need write_orders / write_customers on the
// Shopify app; without them Shopify answers with an access error, which we
// pass back in plain words so it is obvious what to fix.
// ---------------------------------------------------------------------------
function explainShopifyError(err) {
  const m = String((err && err.message) || err || '');
  if (/access|scope|permission|ACCESS_DENIED/i.test(m)) {
    return 'Shopify refused the change - the app needs the write_orders and write_customers scopes. Add them in the Shopify Dev Dashboard, install the new version, then restart the Render service.';
  }
  return m;
}

function cleanAddress(a) {
  a = a || {};
  const pick = (k) => (a[k] === undefined || a[k] === null ? undefined : String(a[k]).trim());
  return {
    firstName: pick('firstName'),
    lastName: pick('lastName'),
    address1: pick('address1'),
    address2: pick('address2'),
    city: pick('city'),
    provinceCode: pick('provinceCode'),
    zip: pick('zip'),
    countryCode: pick('countryCode') || 'US',
    phone: pick('phone'),
  };
}

const ORDER_ADDRESS_MUTATION = `
  mutation($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id name shippingAddress { address1 address2 city provinceCode zip countryCode firstName lastName phone } }
      userErrors { field message }
    }
  }`;

app.post('/api/orders/address', async (req, res) => {
  if (!checkToken(req, res)) return;
  try {
    const { orderId, address } = req.body || {};
    if (!orderId || !address) return res.status(400).json({ error: 'orderId and address are required' });
    const input = { id: orderId, shippingAddress: cleanAddress(address) };
    const data = await shopifyGraphQL(ORDER_ADDRESS_MUTATION, { input });
    const errs = (data.orderUpdate && data.orderUpdate.userErrors) || [];
    if (errs.length) return res.status(400).json({ error: errs.map((e) => e.message).join('; ') });
    res.json({ ok: true, order: data.orderUpdate.order });
  } catch (err) {
    console.error('Order address update failed:', err.message);
    res.status(500).json({ error: explainShopifyError(err) });
  }
});

const CUSTOMER_UPDATE_MUTATION = `
  mutation($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id displayName email phone note }
      userErrors { field message }
    }
  }`;

app.post('/api/customer/update', async (req, res) => {
  if (!checkToken(req, res)) return;
  try {
    const { customerId, firstName, lastName, phone, note } = req.body || {};
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });
    const input = { id: customerId };
    if (firstName !== undefined) input.firstName = String(firstName).trim();
    if (lastName !== undefined) input.lastName = String(lastName).trim();
    if (phone !== undefined) input.phone = String(phone).trim() || null;
    if (note !== undefined) input.note = String(note).trim();
    const data = await shopifyGraphQL(CUSTOMER_UPDATE_MUTATION, { input });
    const errs = (data.customerUpdate && data.customerUpdate.userErrors) || [];
    if (errs.length) return res.status(400).json({ error: errs.map((e) => e.message).join('; ') });
    res.json({ ok: true, customer: data.customerUpdate.customer });
  } catch (err) {
    console.error('Customer update failed:', err.message);
    res.status(500).json({ error: explainShopifyError(err) });
  }
});

app.get('/api/shopify-check', async (req, res) => {
  try {
    const token = await getShopifyToken();
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/shop.json`, {
      headers: { 'X-Shopify-Access-Token': token },
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ ok: false, httpStatus: r.status, body });
    res.json({ ok: true, store: body.shop && body.shop.myshopify_domain });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Customer photos. The Gmail import posts each image here once; the Inbox
// reads them back with the dashboard token (as ?token= so <img> tags work).
// ---------------------------------------------------------------------------
// Big photos arrive in pieces (the Zapier webhook step caps its payload), so
// each request carries {chunkIndex, chunkCount} and the pieces are held here
// until the last one lands. Partial uploads are dropped after 10 minutes.
const pendingChunks = new Map();
function pendingKey(messageId, attachmentId) { return `${messageId}/${attachmentId}`; }
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of pendingChunks) if (v.startedAt < cutoff) pendingChunks.delete(k);
}, 60 * 1000).unref();

app.post('/api/attachments', async (req, res) => {
  try {
    const { threadId, messageId, attachmentId, filename, mimeType, data } = req.body || {};
    if (!messageId || !attachmentId || !data) return res.status(400).json({ error: 'messageId, attachmentId and data are required' });
    if (!(dbReady && Attachment)) return res.status(503).json({ error: 'Database not ready' });

    const chunkCount = Math.max(1, Number(req.body.chunkCount) || 1);
    const chunkIndex = Math.max(0, Number(req.body.chunkIndex) || 0);
    let b64 = String(data);
    if (chunkCount > 1) {
      const key = pendingKey(messageId, attachmentId);
      const entry = pendingChunks.get(key) || { parts: new Array(chunkCount).fill(null), startedAt: Date.now() };
      entry.parts[chunkIndex] = b64;
      pendingChunks.set(key, entry);
      const have = entry.parts.filter((p) => p !== null).length;
      if (have < chunkCount) return res.json({ ok: true, pending: true, have, chunkCount });
      pendingChunks.delete(key);
      b64 = entry.parts.join('');
    }

    const buf = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (!buf.length) return res.status(400).json({ error: 'Empty file' });
    if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'File too large' });
    await Attachment.findOneAndUpdate(
      { messageId: String(messageId), attachmentId: String(attachmentId) },
      { threadId: String(threadId || ''), filename: String(filename || 'file'), mimeType: String(mimeType || 'application/octet-stream'), size: buf.length, data: buf },
      { upsert: true, new: true }
    );
    res.json({ ok: true, bytes: buf.length });
  } catch (err) {
    console.error('Attachment save failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/att/:messageId/:attachmentId', async (req, res) => {
  if (!readGate(req, res)) return;
  try {
    if (!(dbReady && Attachment)) return res.status(503).json({ error: 'Database not ready' });
    const a = await Attachment.findOne({ messageId: req.params.messageId, attachmentId: req.params.attachmentId }).lean();
    if (!a || !a.data) return res.status(404).json({ error: 'Not stored' });
    res.set('Content-Type', a.mimeType || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${String(a.filename || 'file').replace(/"/g, '')}"`);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(Buffer.isBuffer(a.data) ? a.data : Buffer.from(a.data.buffer || a.data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Which stored photos exist for a thread - lets the Inbox know what to render
// without probing every attachment id.
app.get('/api/att-index', async (req, res) => {
  if (!readGate(req, res)) return;
  try {
    if (!(dbReady && Attachment)) return res.json({ ok: true, stored: [] });
    const threadId = String(req.query.threadId || '');
    if (!threadId) return res.status(400).json({ error: 'Pass ?threadId=' });
    const rows = await Attachment.find({ threadId }, { messageId: 1, attachmentId: 1, mimeType: 1, size: 1, filename: 1 }).lean();
    res.json({ ok: true, stored: rows.map((r) => ({ messageId: r.messageId, attachmentId: r.attachmentId, mimeType: r.mimeType, size: r.size, filename: r.filename })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Customer search for the panel. By email first; if that misses, by the order
// number in the email (people check out with one address and write from
// another), and finally a name search that returns candidates to pick from.
// ---------------------------------------------------------------------------
const ORDER_OWNER_QUERY = `
  query($q: String!) {
    orders(first: 1, query: $q) { edges { node { name email customer { id email displayName } } } }
  }`;
const CUSTOMER_SEARCH_QUERY = `
  query($q: String!) {
    customers(first: 5, query: $q) { edges { node { id displayName email numberOfOrders defaultAddress { city provinceCode } } } }
  }`;

async function customerByOrderNumber(orderNumber) {
  const raw = String(orderNumber || '').replace(/^#/, '').trim();
  if (!raw) return null;
  try {
    const data = await shopifyGraphQL(ORDER_OWNER_QUERY, { q: `name:#${raw}` });
    const edge = data.orders && data.orders.edges && data.orders.edges[0];
    if (!edge) return null;
    const o = edge.node;
    const email = (o.customer && o.customer.email) || o.email;
    return email ? getCustomerContext(email) : null;
  } catch (err) {
    console.error('Order owner lookup failed:', err.message);
    return null;
  }
}

async function searchCustomers(name) {
  const q = String(name || '').trim();
  if (q.length < 2) return [];
  try {
    const data = await shopifyGraphQL(CUSTOMER_SEARCH_QUERY, { q });
    return ((data.customers && data.customers.edges) || []).map((e) => ({
      id: e.node.id, name: e.node.displayName, email: e.node.email, totalOrders: e.node.numberOfOrders,
      location: e.node.defaultAddress ? [e.node.defaultAddress.city, e.node.defaultAddress.provinceCode].filter(Boolean).join(', ') : null,
    }));
  } catch (err) {
    console.error('Customer search failed:', err.message);
    return [];
  }
}

function shapeProfile(customer) {
  if (!customer) return null;
  return {
    id: customer.id, name: customer.name, firstName: customer.firstName, lastName: customer.lastName,
    email: customer.email, phone: customer.phone, since: customer.since, address: customer.address,
    totalOrders: customer.totalOrders, totalSpent: customer.totalSpent, location: customer.location,
    tags: customer.tags, note: customer.note, orders: customer.orders,
  };
}

app.get('/api/customer-search', async (req, res) => {
  if (!readGate(req, res)) return;
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    const order = String(req.query.order || '').trim();
    const name = String(req.query.name || '').trim();
    let customer = email ? await getCustomerContext(email) : null;
    let matchedBy = customer ? 'email' : null;
    if (!customer && order) { customer = await customerByOrderNumber(order); if (customer) matchedBy = 'order'; }
    let candidates = [];
    if (!customer && name) candidates = await searchCustomers(name);
    if (!customer && !candidates.length && email) {
      // Last try: the part before the @ is often the person's name.
      const guess = email.split('@')[0].replace(/[\d._-]+/g, ' ').trim();
      if (guess.length >= 3) candidates = await searchCustomers(guess);
    }
    const cart = customer ? await getOpenCart(customer.email || email) : null;
    res.json({ ok: true, matchedBy, profile: shapeProfile(customer), cart, candidates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Install-on-phone bits: a web app manifest and icons so "Add to Home Screen"
// opens the Inbox full-screen with its own icon.
// ---------------------------------------------------------------------------
let iconCache = null;
function icons() {
  if (iconCache) return iconCache;
  try {
    iconCache = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'icons.json'), 'utf8'));
  } catch (e) {
    iconCache = {};
  }
  return iconCache;
}
function sendIcon(res, key) {
  const b64 = icons()[key];
  if (!b64) return res.status(404).end();
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=604800');
  res.send(Buffer.from(b64, 'base64'));
}
app.get('/icon-192.png', (req, res) => sendIcon(res, '192'));
app.get('/apple-touch-icon.png', (req, res) => sendIcon(res, 'apple'));
app.get('/manifest.webmanifest', (req, res) => {
  res.set('Content-Type', 'application/manifest+json');
  res.json({
    name: 'Crib Essentials Inbox',
    short_name: 'CE Inbox',
    description: 'Customer email inbox for Crib Essentials',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#111111',
    theme_color: '#111111',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

// Non-sensitive import check: which threads are in, how much conversation each
// carries, and whether photos came through. No customer text is exposed.
app.get('/api/import-status', async (req, res) => {
  try {
    const rows = await listLeads();
    let stored = [];
    if (dbReady && Attachment) {
      try { stored = await Attachment.find({}, { threadId: 1, messageId: 1 }).lean(); } catch (e) { /* ignore */ }
    }
    res.json({
      ok: true,
      count: rows.length,
      leads: rows.map((l) => ({
        threadId: l.threadId || null,
        status: l.status,
        needsHuman: Boolean(l.needsHuman),
        threadLen: Array.isArray(l.thread) ? l.thread.length : 0,
        attachments: (Array.isArray(l.attachments) ? l.attachments.length : 0) +
          (Array.isArray(l.thread) ? l.thread.reduce((n, m) => n + ((m.attachments || []).length), 0) : 0),
        drafts: Array.isArray(l.drafts) ? l.drafts.length : 0,
        hasProfile: Boolean(l.customerProfile),
        summaryLen: String(l.aiAnalysis || '').length,
        receivedAt: l.receivedAt || null,
        replyLen: String(l.aiResponse || '').length,
        createdAt: l.createdAt,
      })),
      storedAttachments: stored.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', async (req, res) => {
  let leadCount = memoryLeads.length;
  if (dbReady && Lead) {
    try {
      leadCount = await Lead.countDocuments();
    } catch (err) {
      /* fall through to memory count */
    }
  }
  res.json({
    status: 'ok',
    version: 'v13.7 - re-imports never reopen a conversation you already answered',
    storage: dbReady ? 'mongodb (persistent)' : 'in-memory (resets on restart)',
    dbError: dbError || null,
    leadsStored: leadCount,
    faqSource: faqSource(),
    env: {
      CLAUDE_API_KEY: process.env.CLAUDE_API_KEY ? 'set' : 'MISSING',
      SHOPIFY_CLIENT_ID: SHOPIFY_CLIENT_ID ? 'set' : 'MISSING',
      SHOPIFY_CLIENT_SECRET: SHOPIFY_CLIENT_SECRET ? 'set' : 'MISSING',
      SUPPORT_FAQ: process.env.SUPPORT_FAQ ? 'set' : 'not set (using built-in)',
      MONGODB_URI: MONGODB_URI ? 'set' : 'not set (leads in memory)',
      SEND_WEBHOOK_URL: process.env.SEND_WEBHOOK_URL ? 'set' : 'MISSING (sending disabled)',
      DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ? 'set' : 'MISSING (sending disabled)',
    },
  });
});

const PORT = process.env.PORT || 3000;
// The Inbox dashboard is served straight from this server, so updating it is
// just replacing index.html next to server.js on GitHub - no Netlify step.
const path = require('path');
const fs = require('fs');
app.get(['/', '/inbox'], (req, res) => {
  const file = path.join(__dirname, 'index.html');
  if (!fs.existsSync(file)) {
    return res
      .status(404)
      .send('index.html is not in the repo yet. Upload it next to server.js on GitHub and Render will redeploy.');
  }
  res.set('Cache-Control', 'no-store');
  res.sendFile(file);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
