# Crib Essentials Email Support Agent - Deployment Guide

This guide will walk you through setting up the complete email automation system in the cloud.

## System Overview

1. **Backend (Node.js)** — Processes emails, queries Shopify, calls Claude API
2. **Database (MongoDB)** — Stores all lead data
3. **Dashboard (React)** — View all customer emails and order info
4. **Zapier** — Connects Gmail to the backend

---

## Step 1: Set Up MongoDB Database (FREE)

1. Go to **mongodb.com/cloud/atlas**
2. Click **Try Free**
3. Sign up with your email
4. Create a project called "crib-essentials"
5. Create a free cluster (M0)
6. Set username and password (save these!)
7. In **Network Access**, click **Add IP Address** → **Allow from anywhere**
8. Go to **Databases** → Click your cluster → **Connect** → **Drivers**
9. Copy the connection string. It looks like:
   ```
   mongodb+srv://username:password@cluster.mongodb.net/crib-essentials
   ```
10. Replace `username` and `password` with your credentials
11. **Save this connection string** — you'll need it in Step 3

---

## Step 2: Deploy Backend to Render (FREE)

1. Go to **render.com**
2. Sign up with your GitHub account (or create account)
3. Click **Create New** → **Web Service**
4. Select **Deploy an existing repository** or **Paste a public Git URL**
5. If you don't have a Git repo yet:
   - Go to **github.com** → Create new repository named `crib-essentials-email-agent`
   - Initialize with README
   - Clone it locally: `git clone https://github.com/YOUR-USERNAME/crib-essentials-email-agent.git`
   - Copy all the files from `/root/crib-essentials-email-agent/` into this folder
   - Commit and push: 
     ```bash
     git add .
     git commit -m "Initial commit: email automation system"
     git push origin main
     ```

6. In Render, connect your GitHub repo
7. Fill in the details:
   - **Name:** `crib-essentials-email-agent`
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`

8. Click **Advanced** → **Add Environment Variable**
   - Add your environment variables (see Step 3 below)

9. Click **Deploy**
   - Wait 3-5 minutes for deployment to complete
   - You'll get a URL like `https://crib-essentials-email-agent.onrender.com`
   - **Save this URL** — you'll need it for Zapier

---

## Step 3: Add Environment Variables

Before deploying, you need to set your API keys. In Render (or wherever you deploy):

**Environment Variables to Add:**

```
CLAUDE_API_KEY=sk-ant-xxxxx...
SHOPIFY_ACCESS_TOKEN=shpat_xxxxx...
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/crib-essentials
PORT=3000
```

Where:
- **CLAUDE_API_KEY** — From console.anthropic.com (you already have this)
- **SHOPIFY_ACCESS_TOKEN** — From your Shopify admin (you already have this)
- **MONGODB_URI** — From Step 1 above

---

## Step 4: Access the CRM Dashboard

1. Your backend URL is: `https://crib-essentials-email-agent.onrender.com`
2. Open `dashboard.html` in your browser OR deploy it to a CDN
3. For local testing:
   - Open the `dashboard.html` file directly in your browser
   - Update the API_URL in the file to point to your backend
   - Or set environment variable: `REACT_APP_API_URL=https://your-backend-url.onrender.com`

For production, deploy `dashboard.html` to:
- **Netlify** (drag & drop the file) — FREE
- **Vercel** (git-based deployment) — FREE
- Or host on your own domain

---

## Step 5: Connect Zapier Workflow

Now connect Gmail to your backend so emails trigger automatic responses.

### 5.1 Create a Zapier Account
1. Go to **zapier.com**
2. Sign up with your email
3. Click **Create a Zap**

### 5.2 Set Up Gmail Trigger
1. Choose **Trigger App:** Gmail
2. Choose **Event:** New Email
3. Connect your Gmail account (`support@1cribessentials.com`)
4. Set filter:
   - To: `support@1cribessentials.com`
   - From any sender

### 5.3 Connect to Your Backend
1. In Zapier, add an action: **Webhooks by Zapier** → **POST**
2. **URL:** `https://your-backend-url.onrender.com/api/process-email`
3. **Method:** POST
4. **Data:**
   ```json
   {
     "from": "{Gmail trigger - From}",
     "customerName": "{Gmail trigger - From Name}",
     "subject": "{Gmail trigger - Subject}",
     "body": "{Gmail trigger - Body}"
   }
   ```

### 5.4 Send Email Reply
1. Add another action: **Gmail** → **Send Email**
2. **To:** `{Gmail trigger - From}`
3. **Subject:** `Re: {Gmail trigger - Subject}`
4. **Body:** Use the response from your backend:
   ```
   {response}
   ```

---

## Step 6: Test the System

1. Send a test email to `support@1cribessentials.com`:
   - Subject: "What's your shipping time?"
   - Body: "Hey, how long does shipping take for wall art?"

2. Wait 30 seconds for Zapier to trigger

3. Check:
   - ✅ Did you get a reply email?
   - ✅ Is the lead in your CRM dashboard?
   - ✅ Does the response mention your shipping policy?

---

## Troubleshooting

### "Backend URL not responding"
- Check that Render deployment is complete (check the Render dashboard)
- Test: Visit `https://your-url.onrender.com/api/health`
- Should return: `{"status":"ok"}`

### "Email not replying"
- Check Zapier logs for errors
- Verify Gmail is connected in Zapier
- Test webhook manually in Zapier editor

### "Order info not showing"
- Verify Shopify access token is correct
- Check if order exists in Shopify
- Test Shopify API directly

### "Dashboard showing no leads"
- Verify backend API URL in dashboard.html
- Check MongoDB connection string
- Open browser console for errors

---

## Next Steps

1. **Customize your FAQ** — Edit the DEFAULT_FAQ in `server.js`
2. **Update product info** — Add your specific products and responses
3. **Monitor leads** — Check the dashboard daily
4. **Optimize responses** — Refine Claude's prompts based on responses

---

## Support

If you run into issues:
1. Check Render logs: `Render Dashboard → Your Service → Logs`
2. Check Zapier logs: `Zapier Dashboard → Your Zap → Zap History`
3. Test API manually: Use Postman or curl to test the `/api/process-email` endpoint

Good luck! 🚀
