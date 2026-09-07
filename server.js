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

const DEFAULT_FAQ = `
Q: How long does shipping take?
A: Typically 5-7 business days. We ship from Dallas, TX.

Q: Do you offer tracking?
A: Yes, all orders include tracking via the carrier.

Q: What's your return policy?
A: 30-day returns on most items if unused and in original packaging.

Q: Can I customize sizes/colors?
A: Yes! We offer custom orders. Email support@1cribessentials.com with your request.

Q: Do you ship internationally?
A: Currently US only. International coming soon.

Q: What materials do you use?
A: All handmade using premium materials. Details vary by product.

Q: Can I order wholesale?
A: Yes, email support@1cribessentials.com for bulk pricing.
`;

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
    console.error('Shopify lookup failed:', error.message);
    return null;
  }
}

async function analyzeEmailWithClaude(email, faqContext, shopifyData) {
  const orderBlock = shopifyData
    ? `Customer Order Info:
Order Number: ${shopifyData.orderNumber}
Status: ${shopifyData.status}
Fulfillment Status: ${shopifyData.fulfillmentStatus}
Products: ${shopifyData.products.map((p) => `${p.name} (Qty: ${p.quantity})`).join(', ')}
Tracking: ${
        shopifyData.trackingInfo.length
          ? shopifyData.trackingInfo.map((t) => `${t.trackingNumber} (${t.status}) ${t.trackingUrl}`).join('; ')
          : 'No tracking info yet'
      }`
    : '';

  const prompt = `You are a helpful customer support agent for Crib Essentials, a handmade home decor brand selling wall art, rugs, mirrors, and decorative pieces.

Customer Email:
"${email}"

FAQ Context:
${faqContext}

${orderBlock}

Please:
1. Identify if this is an order inquiry, product question, or general support request
2. If it's an order inquiry, provide relevant tracking/delivery information
3. Generate a helpful, friendly response in 2-3 sentences
4. Keep it personal and brand-appropriate for Crib Essentials

Respond with ONLY raw JSON, no markdown fences:
{
  "type": "order_inquiry" | "product_question" | "general_support",
  "summary": "brief summary of what customer is asking",
  "response": "the email response to send to the customer",
  "extractedOrderNumber": "if mentioned, the order number, otherwise null"
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
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
    };
  }
}

app.post('/api/process-email', async (req, res) => {
  try {
    const { from, customerName, body, faqContext = DEFAULT_FAQ } =
