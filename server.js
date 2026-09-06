const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI);

const leadSchema = new mongoose.Schema({
  email: String,
  customerName: String,
  question: String,
  orderNumber: String,
  productType: String,
  shopifyOrderData: Object,
  aiAnalysis: String,
  aiResponse: String,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  repliedAt: Date,
});

const Lead = mongoose.model('Lead', leadSchema);

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

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

async function getShopifyOrder(orderNumber) {
  try {
    const shopifyUrl = `https://1cribessentials.shop/admin/api/2024-01/orders.json?name=${orderNumber}&status=any`;
    const response = await fetch(shopifyUrl, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    if (data.orders && data.orders.length > 0) {
      const order = data.orders[0];
      return {
        orderNumber: order.order_number,
        status: order.financial_status,
        fulfillmentStatus: order.fulfillment_status,
        createdAt: order.created_at,
        total: order.total_price,
        products: order.line_items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
        })),
        trackingInfo: order.fulfillments
          ? order.fulfillments.map((f) => ({
              trackingNumber: f.tracking_number || 'N/A',
              trackingUrl: f.tracking_url || 'N/A',
              status: f.status,
              createdAt: f.created_at,
            }))
          : [],
      };
    }
    return null;
  } catch (error) {
    console.error('Error fetching Shopify order:', error);
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
Tracking Info: ${
        shopifyData.trackingInfo && shopifyData.trackingInfo.length > 0
          ? shopifyData.trackingInfo
              .map((t) => `Tracking: ${t.trackingNumber} (Status: ${t.status}) - ${t.trackingUrl}`)
              .join('; ')
          : 'No tracking info available yet'
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

Respond with ONLY raw JSON, no markdown fences, in this shape:
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

  let responseText = message.content[0].text.trim();
  responseText = responseText.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();

  try {
    return JSON.parse(responseText);
  } catch (e) {
    return {
      type: 'general_support',
      summary: 'Could not parse AI response',
      response: responseText,
      extractedOrderNumber: null,
    };
  }
}

app.post('/api/process-email', async (req, res) => {
  try {
    const { from, customerName, subject, body, faqContext = DEFAULT_FAQ } = req.body;

    const initialAnalysis = await analyzeEmailWithClaude(body, faqContext, null);

    let shopifyData = null;
    if (initialAnalysis.extractedOrderNumber) {
      shopifyData = await getShopifyOrder(initialAnalysis.extractedOrderNumber);
    }

    const finalAnalysis = shopifyData
      ? await analyzeEmailWithClaude(body, faqContext, shopifyData)
      : initialAnalysis;

    const lead = new Lead({
      email: from,
      customerName,
      question: body,
      orderNumber: finalAnalysis.extractedOrderNumber,
      productType: finalAnalysis.type,
      shopifyOrderData: shopifyData,
      aiAnalysis: finalAnalysis.summary,
      aiResponse: finalAnalysis.response,
      status: 'replied',
      repliedAt: new Date(),
    });

    await lead.save();

    res.json({
      success: true,
      lead: lead,
      response: finalAnalysis.response,
    });
  } catch (error) {
    console.error('Error processing email:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/leads', async (req, res) => {
  try {
    const leads = await Lead.find().sort({ createdAt: -1 });
    res.json(leads);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/leads/:id', async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    res.json(lead);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/leads/:id', async (req, res) => {
  try {
    const lead = await Lead.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(lead);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
