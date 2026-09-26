# 🚀 Deploying QuantumConnect Backend 24/7 (Even When Laptop is Offline)

QuantumConnect features an automatic **dual-engine architecture**:
1. **Local & Cloud Fallback**: When your laptop is turned off or local server is offline, the app seamlessly uses Google Cloud Firestore with zero disruption.
2. **Dedicated Cloud Server**: When you deploy this repository to the cloud (Render, Railway, or VPS), your custom backend runs 24/7 with zero cost and stores all chats, files, and WebRTC calls persistently in the cloud.

---

## 📦 Step 1: Push to GitHub

In `n:\001\QC Server Backend`:

```bash
# 1. Stage and commit files
git add .
git commit -m "feat: complete v2.1 backend with group chats, search, read receipts & docker"

# 2. Add your GitHub repository remote (replace YOUR_GITHUB_USERNAME)
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/qc-server-backend.git
git branch -M main

# 3. Push to GitHub
git push -u origin main
```

---

## ☁️ Step 2: Deploy in 1-Click to Free Cloud Hosting

### 🌟 Option A: Render.com (Recommended — 100% Free & Automatic)
1. Go to [Render Dashboard](https://dashboard.render.com/) and click **New** > **Web Service**.
2. Connect your GitHub account and choose `qc-server-backend`.
3. Set:
   - **Name**: `qc-server-backend`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
4. Click **Create Web Service**.
5. Render deploys your server in ~60 seconds and gives you a free HTTPS URL:
   `https://qc-server-backend.onrender.com`

### 🚂 Option B: Railway.app
1. Go to [Railway](https://railway.app/) and click **New Project** > **Deploy from GitHub repo**.
2. Select `qc-server-backend`.
3. Railway automatically detects the included `Dockerfile` and gives you a free live URL.

### 🐳 Option C: Koyeb / Fly.io / Docker VPS
Run with Docker:
```bash
docker run -d -p 4000:4000 --restart always --name qc-server qc-server-backend
```

---

## 📱 Step 3: Connect QuantumConnect Frontend

Once your backend is deployed:
1. Open the QuantumConnect app on Web or Android.
2. Open **Settings** > **Backend Connection**.
3. Paste your live URL:
   ```
   https://qc-server-backend.onrender.com
   ```
4. Click **Save & Connect**.
5. The connection badge will turn green 🟢 **Connected to Dedicated Server Backend**!

All devices (Android phone, laptop, desktop browser) will now communicate in real-time through your dedicated cloud server 24 hours a day, 7 days a week!
