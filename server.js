const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

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
    status: { type: String, default: 'drafted' },
    needsHuman: { type: Boolean, default: false },
    flagReason: String,
    // Three ways of saying the same thing. drafts[0] is always the vetted
    // original; the others are tone rewrites that may not add facts.
    drafts: [{ tone: String, label: String, text: String }],
    // Shopify Inbox-style panel: who they are, what they bought, what's in their cart.
    customerProfile: Object,
    cart: Object,
    // The email exactly as it arrived, and the quoted history parsed into messages.
    rawBody: String,
    thread: [{ name: String, email: String, date: String, text: String, mine: Boolean }],
    sentAt: Date,
    sentBody: String,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

if (MONGODB_URI) {
  Lead = mongoose.model('Lead', leadSchema);
  mongoose
    .connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
    .then(() => {
      dbReady = true;
      dbError = null;
      console.log('MongoDB connected - leads will persist');
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

async function saveLead(lead) {
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

async function listLeads() {
  if (dbReady && Lead) {
    try {
      return await Lead.find().sort({ createdAt: -1 }).limit(MAX_LEADS).lean();
    } catch (err) {
      console.error('Lead read from MongoDB failed:', err.message);
    }
  }
  return memoryLeads;
}

async function findLead(id) {
  if (dbReady && Lead) {
    try {
      return await Lead.findById(id).lean();
    } catch (err) {
      console.error('Lead lookup failed:', err.message);
    }
  }
  return memoryLeads.find((l) => l._id === id) || null;
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

function getFaq() {
  const custom = process.env.SUPPORT_FAQ;
  return custom && custom.trim() ? custom : BUILTIN_FAQ;
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
          displayName
          email
          phone
          createdAt
          numberOfOrders
          amountSpent { amount }
          defaultAddress { city provinceCode countryCode }
          tags
          note
          orders(first: 5, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                name
                createdAt
                displayFinancialStatus
                displayFulfillmentStatus
                totalPriceSet { shopMoney { amount } }
                lineItems(first: 10) { edges { node { title variantTitle quantity product { id } } } }
                fulfillments(first: 3) { trackingInfo { number url company } }
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
      name: c.displayName,
      email: c.email,
      phone: c.phone || null,
      since: c.createdAt || null,
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
          name: o.name,
          createdAt: o.createdAt,
          financial: o.displayFinancialStatus,
          fulfillment: o.displayFulfillmentStatus,
          total: o.totalPriceSet && o.totalPriceSet.shopMoney ? o.totalPriceSet.shopMoney.amount : null,
          items: (o.lineItems.edges || []).map((le) => ({
            title: le.node.title,
            variant: le.node.variantTitle && le.node.variantTitle !== 'Default Title' ? le.node.variantTitle : null,
            quantity: le.node.quantity,
            productId: le.node.product ? le.node.product.id : null,
          })),
          tracking: tracking,
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
          fulfillments(first: 5) { trackingInfo { number url company } }
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
  const dm = rest.match(/^(.*?\d{1,2}:\d{2}\s?(?:AM|PM)?)\s+(.+)$/i) || rest.match(/^(.*?\d{4})\s+(.+)$/);
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
Placed: ${shopifyData.createdAt}${age !== null ? ` (${age} days ago)` : ''}
Payment status: ${shopifyData.status}
Fulfillment status: ${shopifyData.fulfillmentStatus || 'unfulfilled'}
Items on this order (the order cannot ship before its slowest item - each item's production time is on its product page below):
${shopifyData.products.map((p) => `  - ${p.name} (qty ${p.quantity})${p.freeGift ? ' - FREE GIFT, $0, added automatically' : ''}`).join('\n')}
Tracking: ${
      shopifyData.trackingInfo.length
        ? shopifyData.trackingInfo
            .map((t) => `${t.trackingNumber} (${t.status}) ${t.trackingUrl}`)
            .join('; ')
        : 'not shipped yet - no tracking'
    }
`;
  }

  const prompt = `You are a customer support agent for Crib Essentials, a handmade home decor brand in Dallas, TX selling wall art, mirrors, rugs, pillows and decorative pieces.

TODAY'S DATE: ${today}

EMAIL SUBJECT LINE: "${extra.subject || ''}"
(An order number in the subject line counts exactly like one in the body - e.g. "Re: Order #2715 confirmed" means they are asking about order 2715.)

CUSTOMER'S NEW MESSAGE (this is what you are replying to - answer THIS):
"${email}"
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
- Warm, brief, 2-5 sentences. Write as a real person at the brand, not a bot.

Respond with ONLY raw JSON, no markdown fences:
{
  "type": "order_inquiry" | "product_question" | "general_support",
  "summary": "one line on what the customer needs",
  "response": "the reply to send",
  "extractedOrderNumber": "order number if mentioned in the body OR the subject line, else null",
  "productKeywords": ["product names or types mentioned, else empty array"],
  "needsHuman": true or false,
  "flagReason": "if needsHuman is true, a few words on what Dezmond needs to do; else null"
}

Set needsHuman to true whenever the STORE POLICIES say to flag the email for Dezmond, whenever your reply says you will check on something and come back, whenever the customer is asking for a change you cannot make (address, cancellation, refund, swap, expedite), and whenever the email is a threat, a legal notice, a partnership or vendor pitch, or something the policies do not cover. When the reply is complete and needs nothing from Dezmond, set it to false.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  });

  let text = message.content[0].text.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();

  try {
    return JSON.parse(text);
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
- Do not say "I'm a real person", do not mention AI, and never use internal language ("the system", "our records", "flagging", "escalating").
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
    const { from, customerName, body: rawBody, subject, threadId, faqContext } = req.body;
    if (!rawBody) return res.status(400).json({ error: 'Missing body in request' });

    // Only the new message is "the email"; the quoted history rides along as context.
    const split = splitQuoted(rawBody);
    const body = split.newText || String(rawBody).trim();
    const history = split.history ? split.history.slice(0, 4000) : '';

    const faq = faqContext && String(faqContext).trim() ? faqContext : getFaq();

    // Look the sender up by email first - most people never quote an order number.
    const [customer, cart] = await Promise.all([getCustomerContext(from), getOpenCart(from)]);
    const customerBlock = formatCustomer(customer);

    // Pass 1: understand the email and pull out the order number / product hints.
    const initial = await askClaude(body, faq, null, '', customerBlock, { subject, history });

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
      ? await askClaude(body, faq, shopifyData, formatProducts(products), customerBlock, { subject, orderMismatch, history })
      : initial;

    const needsHuman = Boolean(final.needsHuman) || Boolean(orderMismatch);
    const flagReason = orderMismatch
      ? `Customer quoted order ${orderMismatch} but it is not under their email - verify before sharing anything`
      : (final.flagReason || null);

    // Three tones of the same vetted reply for the dashboard picker.
    const drafts = await makeDraftVariants(final.response, body);

    const saved = await saveLead({
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
      status: 'drafted',
      needsHuman: needsHuman,
      flagReason: flagReason,
      drafts: drafts,
      rawBody: String(rawBody),
      thread: split.thread,
      customerProfile: customer
        ? {
            name: customer.name, email: customer.email, phone: customer.phone, since: customer.since,
            totalOrders: customer.totalOrders, totalSpent: customer.totalSpent, location: customer.location,
            tags: customer.tags, note: customer.note, orders: customer.orders,
          }
        : null,
      cart: cart,
      createdAt: new Date(),
    });

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
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Pass ?email=someone@example.com' });
    const c = await getCustomerContext(email);
    res.json({ ok: true, found: Boolean(c), customer: c });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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
    version: 'v12.2 - inbox served from Render at /, token-gated leads, thread split, customer panel + cart, three draft tones',
    storage: dbReady ? 'mongodb (persistent)' : 'in-memory (resets on restart)',
    dbError: dbError || null,
    leadsStored: leadCount,
    faqSource: process.env.SUPPORT_FAQ ? 'SUPPORT_FAQ env var' : 'built-in fallback',
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
