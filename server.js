const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// In-memory lead store. Resets whenever the service restarts.
const leads = [];
const MAX_LEADS = 500;
let nextId = 1;

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
    }));
    productCache.set(key, { value: items, expires: Date.now() + PRODUCT_CACHE_MS });
    return items;
  } catch (err) {
    console.error('Product search failed:', err.message);
    return [];
  }
}

async function gatherProducts(keywords, lineItemNames) {
  const terms = [];
  (keywords || []).forEach((k) => terms.push(k));
  (lineItemNames || []).forEach((n) => terms.push(String(n).split(' - ')[0]));

  const unique = [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))].slice(0, 3);

  const results = await Promise.all(unique.map((t) => searchProducts(t)));

  const seen = new Set();
  const merged = [];
  results.flat().forEach((p) => {
    if (!seen.has(p.title)) {
      seen.add(p.title);
      merged.push(p);
    }
  });
  return merged.slice(0, 4);
}

function formatProducts(products) {
  if (!products || products.length === 0) return '';
  const lines = products.map((p) => {
    const parts = [`- ${p.title}`];
    if (p.price) parts.push(`  Price: $${p.price}`);
    if (p.options) parts.push(`  Options: ${p.options}`);
    if (typeof p.inventory === 'number') parts.push(`  Inventory on hand: ${p.inventory}`);
    if (p.description) parts.push(`  Product page says: ${p.description}`);
    return parts.join('\n');
  });
  return `\nRELEVANT PRODUCTS (from the live Shopify catalog - these production and shipping times override any general estimate in the FAQ):\n${lines.join('\n\n')}\n`;
}

async function getShopifyOrder(orderNumber) {
  try {
    const token = await getShopifyToken();
    const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json?name=${encodeURIComponent(orderNumber)}&status=any`;
    const response = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    const data = await response.json().catch(() => ({}));

    if (!data.orders || data.orders.length === 0) return null;
    const order = data.orders[0];

    return {
      orderNumber: order.order_number,
      orderName: order.name,
      status: order.financial_status,
      fulfillmentStatus: order.fulfillment_status,
      createdAt: order.created_at,
      total: order.total_price,
      products: (order.line_items || []).map((i) => ({ name: i.name, quantity: i.quantity })),
      trackingInfo: (order.fulfillments || []).map((f) => ({
        trackingNumber: f.tracking_number || 'N/A',
        trackingUrl: f.tracking_url || 'N/A',
        status: f.status,
      })),
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

async function askClaude(email, faqContext, shopifyData, productBlock) {
  let orderBlock = '';
  if (shopifyData) {
    const age = daysSince(shopifyData.createdAt);
    orderBlock = `
CUSTOMER ORDER (live from Shopify):
Order: ${shopifyData.orderName || shopifyData.orderNumber}
Placed: ${shopifyData.createdAt}${age !== null ? ` (${age} days ago)` : ''}
Payment status: ${shopifyData.status}
Fulfillment status: ${shopifyData.fulfillmentStatus || 'unfulfilled'}
Items: ${shopifyData.products.map((p) => `${p.name} (qty ${p.quantity})`).join(', ')}
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

CUSTOMER EMAIL:
"${email}"

STORE POLICIES AND CURRENT NOTICES:
${faqContext}
${orderBlock}${productBlock}

RULES:
- Most items are handmade to order. Never promise a delivery date faster than the product's stated production time.
- If a product's own description is shown above, trust its production time over any general estimate in the policies.
- If a notice above mentions a delay or a temporary change, reflect it in your answer.
- If the order is unfulfilled and older than its expected production window, acknowledge the wait honestly rather than restating the standard estimate.
- Never invent tracking numbers, dates, prices or stock levels. If you do not have the information, say you will check and follow up.
- Warm, brief, 2-4 sentences. Write as a real person at the brand, not a bot.

Respond with ONLY raw JSON, no markdown fences:
{
  "type": "order_inquiry" | "product_question" | "general_support",
  "summary": "one line on what the customer needs",
  "response": "the reply to send",
  "extractedOrderNumber": "order number if mentioned, else null",
  "productKeywords": ["product names or types mentioned, else empty array"]
}`;

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
    };
  }
}

app.post('/api/process-email', async (req, res) => {
  try {
    const { from, customerName, body, faqContext } = req.body;
    if (!body) return res.status(400).json({ error: 'Missing body in request' });

    const faq = faqContext && String(faqContext).trim() ? faqContext : getFaq();

    // Pass 1: understand the email and pull out the order number / product hints.
    const initial = await askClaude(body, faq, null, '');

    let shopifyData = null;
    if (initial.extractedOrderNumber) {
      shopifyData = await getShopifyOrder(initial.extractedOrderNumber);
    }

    const lineItemNames = shopifyData ? shopifyData.products.map((p) => p.name) : [];
    const products = await gatherProducts(initial.productKeywords, lineItemNames);

    // Pass 2: answer again, now with the real order and product data in hand.
    const needsSecondPass = Boolean(shopifyData) || products.length > 0;
    const final = needsSecondPass
      ? await askClaude(body, faq, shopifyData, formatProducts(products))
      : initial;

    const lead = {
      _id: String(nextId++),
      email: from,
      customerName,
      question: body,
      orderNumber: final.extractedOrderNumber || initial.extractedOrderNumber || null,
      productType: final.type,
      shopifyOrderData: shopifyData,
      matchedProducts: products.map((p) => p.title),
      aiAnalysis: final.summary,
      aiResponse: final.response,
      status: 'replied',
      createdAt: new Date().toISOString(),
    };

    leads.unshift(lead);
    if (leads.length > MAX_LEADS) leads.pop();

    res.json({ success: true, lead, response: final.response });
  } catch (error) {
    console.error('Error processing email:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/leads', (req, res) => res.json(leads));

app.get('/api/leads/:id', (req, res) => {
  const lead = leads.find((l) => l._id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json(lead);
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

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    storage: 'in-memory',
    leadsStored: leads.length,
    faqSource: process.env.SUPPORT_FAQ ? 'SUPPORT_FAQ env var' : 'built-in fallback',
    env: {
      CLAUDE_API_KEY: process.env.CLAUDE_API_KEY ? 'set' : 'MISSING',
      SHOPIFY_CLIENT_ID: SHOPIFY_CLIENT_ID ? 'set' : 'MISSING',
      SHOPIFY_CLIENT_SECRET: SHOPIFY_CLIENT_SECRET ? 'set' : 'MISSING',
      SUPPORT_FAQ: process.env.SUPPORT_FAQ ? 'set' : 'not set (using built-in)',
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
