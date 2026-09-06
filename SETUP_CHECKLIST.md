# 🚀 Crib Essentials Email Agent - Complete Setup Checklist

Follow this checklist step-by-step. I'll help you with each one.

---

## ✅ PART 1: GitHub Setup (5 minutes)

This stores your code in the cloud so Render can deploy it.

**STEP 1.1: Create GitHub Repository**
- [ ] Go to github.com and sign in (create account if needed)
- [ ] Click **+** (top right) → **New repository**
- [ ] Name: `crib-essentials-email-agent`
- [ ] Description: "Email support automation with AI and Shopify order tracking"
- [ ] Make it **Public**
- [ ] Check **Add a README file**
- [ ] Click **Create repository**

**STEP 1.2: Upload Your Code**
- [ ] On your new repo page, click **Add file** → **Upload files**
- [ ] Drag and drop these files:
  - server.js
  - package.json
  - .env.example
  - dashboard.html
  - DEPLOYMENT.md
- [ ] Scroll down and click **Commit changes**

**STEP 1.3: Copy Your Repository URL**
- [ ] On your repo page, click **Code** (green button)
- [ ] Copy the HTTPS URL (looks like: `https://github.com/YOUR-USERNAME/crib-essentials-email-agent.git`)
- [ ] **Save this URL** — you'll need it for Render

---

## ✅ PART 2: MongoDB Database Setup (3 minutes)

This stores all your customer leads and order data.

**STEP 2.1: Create MongoDB Account**
- [ ] Go to mongodb.com/cloud/atlas
- [ ] Click **Try Free**
- [ ] Sign up with your email
- [ ] Verify your email

**STEP 2.2: Create Cluster**
- [ ] Click **Create** (or **Create a Deployment**)
- [ ] Choose **M0 Sandbox** (FREE tier)
- [ ] Select region closest to you
- [ ] Click **Create Deployment**
- [ ] Wait 2-3 minutes

**STEP 2.3: Create Database User**
- [ ] In the prompt, create a **username** and **password**
- [ ] Check the box: **Autogenerate a secure password** (easier)
- [ ] Copy the password and **save it**
- [ ] Click **Create User**

**STEP 2.4: Allow Network Access**
- [ ] Click **Add My Current IP Address** (or)
- [ ] Click **Add Entry** and type `0.0.0.0/0` (allow from anywhere)
- [ ] Click **Confirm**

**STEP 2.5: Get Connection String**
- [ ] Click **Connect**
- [ ] Choose **Drivers**
- [ ] Select **Node.js**
- [ ] Copy the connection string (looks like):
  ```
  mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/myapp?retryWrites=true&w=majority
  ```
- [ ] Replace `myapp` with `crib-essentials`
- [ ] **Save this entire string** — you'll need it soon

---

## ✅ PART 3: Render Deployment (5 minutes)

This hosts your backend in the cloud so it's always running.

**STEP 3.1: Create Render Account**
- [ ] Go to render.com
- [ ] Click **Sign up**
- [ ] Use **GitHub** to sign up (easier)
- [ ] Authorize Render to access your GitHub

**STEP 3.2: Create Web Service**
- [ ] In Render dashboard, click **New** → **Web Service**
- [ ] Choose **Build and deploy from a Git repository**
- [ ] Search for your repo: `crib-essentials-email-agent`
- [ ] Click **Connect**

**STEP 3.3: Configure Deployment**
- [ ] **Name:** `crib-essentials-email-agent`
- [ ] **Environment:** `Node`
- [ ] **Build Command:** `npm install`
- [ ] **Start Command:** `npm start`
- [ ] **Region:** Choose closest to you

**STEP 3.4: Add Environment Variables**
- [ ] Scroll down to **Environment**
- [ ] Click **Add Environment Variable** and add these:

| Key | Value |
|-----|-------|
| `CLAUDE_API_KEY` | (paste your Claude API key) |
| `SHOPIFY_ACCESS_TOKEN` | (paste your Shopify token) |
| `MONGODB_URI` | (paste your MongoDB connection string) |
| `PORT` | `3000` |

- [ ] Click **Create Web Service**
- [ ] **Wait 3-5 minutes** for deployment
- [ ] Once done, you'll see a URL like: `https://crib-essentials-email-agent.onrender.com`
- [ ] **Copy this URL** — you'll need it

**STEP 3.5: Test Your Backend**
- [ ] Visit: `https://your-render-url.onrender.com/api/health`
- [ ] Should see: `{"status":"ok"}`

---

## ✅ PART 4: CRM Dashboard Setup (2 minutes)

This is where you'll view all your customer emails and orders.

**STEP 4.1: Deploy Dashboard**
Option A: **Quick (Netlify)**
- [ ] Go to netlify.com
- [ ] Click **Upload site** (or drag & drop)
- [ ] Drag `dashboard.html` into the upload area
- [ ] Wait for deployment
- [ ] You'll get a URL like: `https://xxx.netlify.app`
- [ ] **Save this URL**

Option B: **Keep Local**
- [ ] Just open `dashboard.html` in your browser
- [ ] Edit the line at the top:
  ```javascript
  const API_URL = 'https://your-render-url.onrender.com';
  ```

---

## ✅ PART 5: Zapier Workflow Setup (10 minutes)

This connects Gmail to your backend.

**STEP 5.1: Create Zapier Account**
- [ ] Go to zapier.com
- [ ] Sign up with your email
- [ ] Verify email

**STEP 5.2: Create New Zap**
- [ ] Click **Create** (or **+ Create Zap**)

**STEP 5.3: Set Up Gmail Trigger**
- [ ] Search for and select: **Gmail**
- [ ] Choose trigger: **New Email**
- [ ] Click **Sign in with Google**
- [ ] Choose your `support@1cribessentials.com` account
- [ ] Authorize Zapier

**STEP 5.4: Configure Email Filter**
- [ ] In the email settings:
  - [ ] To: `support@1cribessentials.com`
  - [ ] Leave others blank (matches all)
- [ ] Click **Continue**

**STEP 5.5: Send to Your Backend**
- [ ] Click **+ Add Step** → **Action**
- [ ] Search for: **Webhooks by Zapier**
- [ ] Choose: **POST**

**STEP 5.6: Configure Webhook**
- [ ] **URL:** Paste your Render URL: `https://your-render-url.onrender.com/api/process-email`
- [ ] **Method:** POST
- [ ] **Payload Type:** JSON
- [ ] **Data:** Click **Switch to Code** and paste:
```json
{
  "from": "{{1735268437__gmail_data__From}}",
  "customerName": "{{1735268437__gmail_data__From_Name}}",
  "subject": "{{1735268437__gmail_data__Subject}}",
  "body": "{{1735268437__gmail_data__Body}}"
}
```
- [ ] Click **Test & Continue**

**STEP 5.7: Send Reply Email**
- [ ] Click **+ Add Step** → **Action**
- [ ] Search for: **Gmail**
- [ ] Choose: **Send Email**

**STEP 5.8: Configure Reply**
- [ ] **To:** `{{1735268437__gmail_data__From}}`
- [ ] **Subject:** `Re: {{1735268437__gmail_data__Subject}}`
- [ ] **Body:**
```
Thanks for reaching out to Crib Essentials!

{{response}}

Best regards,
Crib Essentials Team
```
- [ ] Click **Test & Continue**

**STEP 5.9: Publish Zap**
- [ ] Click **Publish Zap**
- [ ] Turn it **ON**

---

## ✅ PART 6: Create Your FAQ (5 minutes)

This is what Claude uses to answer customer questions.

**STEP 6.1: Edit Your FAQ**
- [ ] Open `server.js` in a text editor
- [ ] Find the `DEFAULT_FAQ` section (near the bottom)
- [ ] Update with your actual Q&A:

Example:
```javascript
const DEFAULT_FAQ = `
Q: How long does shipping take?
A: Most orders ship within 2-3 business days and arrive in 5-7 days.

Q: Do you offer custom sizes?
A: Yes! We can customize wall art and rugs. Email us for details.

Q: What's your return policy?
A: 30 days if the item is unused and in original condition.

Q: Do you ship internationally?
A: Currently US only, but we're expanding soon!

Q: What materials do you use?
A: All handmade with premium materials - details depend on the product.
`;
```

**STEP 6.2: Push Changes to GitHub**
- [ ] Go to your GitHub repo
- [ ] Click **Edit** on `server.js` (pencil icon)
- [ ] Update the FAQ section
- [ ] Scroll down and click **Commit changes**
- [ ] Render will automatically redeploy! (wait 2-3 min)

---

## ✅ PART 7: Test Everything (2 minutes)

**STEP 7.1: Send Test Email**
- [ ] Send an email to `support@1cribessentials.com` with:
  - Subject: `What's your shipping time?`
  - Body: `Hi, when will my order arrive?`

**STEP 7.2: Check for Reply**
- [ ] Wait 30-60 seconds
- [ ] Check if you got a reply with your FAQ answer

**STEP 7.3: View in CRM**
- [ ] Open your dashboard URL
- [ ] You should see the lead listed
- [ ] Click on it to see the full details

---

## ✅ PART 8: You're Done! 🎉

Your system is now:
- ✅ Monitoring `support@1cribessentials.com`
- ✅ Reading questions with Claude AI
- ✅ Pulling order info from Shopify
- ✅ Sending auto-replies
- ✅ Tracking all leads in your CRM

---

## 📞 Need Help?

**Issue: "Backend not responding"**
- Go to Render dashboard
- Click your service
- Check the Logs tab for errors

**Issue: "Email not replying"**
- Go to Zapier dashboard
- Click your Zap
- Check Zap History for errors

**Issue: "No leads showing in dashboard"**
- Make sure your API_URL in dashboard matches your Render URL
- Check browser console for errors (F12)

---

Let's get started! Ready for Step 1?
