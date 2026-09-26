# ⚡ QuantumConnect — Dedicated Server Backend (v2.1)

[![CI & Docker Build](https://github.com/dhruvsagar/qc-server-backend/actions/workflows/deploy.yml/badge.svg)](https://github.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node: >=18](https://img.shields.io/badge/Node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://docker.com)

A high-performance, production-ready Node.js backend providing **instant real-time messaging, group chats, WebRTC audio/video call signaling, screen sharing, read receipts, message pinning, full-text search, live presence, and persistent per-user storage**.

---

## ✨ Features & Enhancements (v2.1)

- 💬 **Direct & Group Conversations**: 1-on-1 direct messaging + multi-user group chat creation, role management (admin/member), participant addition/removal.
- ⚡ **Zero-Latency Real-Time**: Powered by Socket.IO with bi-directional room broadcasts and fallback polling.
- 📞 **WebRTC Audio & Video Calling Signaling**: SDP offer/answer relay, ICE candidate exchange, live ringtones, decline/end logging, and call duration tracking.
- 🖥️ **Screen Sharing Signaling**: Real-time signal relay for desktop and mobile screen sharing.
- 👥 **Mesh Multi-Party Calling**: Multi-user mesh room join/signal/leave support.
- 👁️ **Read Receipts & Delivery Acknowledgment**: Mark messages as read (`/api/conversations/:id/read` & `message:read` socket event).
- 📌 **Message Pinning & Starred Messages**: Pin crucial messages in conversations and star favorite messages per user.
- 🔍 **Full-Text Global Search**: Instant search across users, conversations, and message streams (`/api/search?q=...`).
- 🟢 **Rich Presence & Custom Status**: Online/offline indicators, last seen timestamps, and customizable status messages with mood emojis.
- 🔒 **Security & Production Hardening**:
  - In-memory sliding-window rate limiting on sensitive routes.
  - Path traversal protection and username sanitization.
  - Dangerous executable extension guard on file uploads.
  - Atomic JSON database persistence (`fs.renameSync`) with rolling backups (`.bak`).
  - Container healthchecks and graceful shutdown handling (`SIGINT`, `SIGTERM`).
- 📊 **Server Telemetry & Metrics**: Real-time stats on active sockets, memory consumption, message count, and system uptime (`/api/stats`).

---

## 🚀 Quick Start (Local Development)

### 1. Install Dependencies
```bash
cd "QC Server Backend"
npm install
```

### 2. Configure Environment (Optional)
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

### 3. Start the Server
```bash
npm start
```

Or run with hot-reload during development:
```bash
npm run dev
```

The server will be live at:
```
http://localhost:4000
```
- Health Check: `http://localhost:4000/api/health`
- Server Metrics: `http://localhost:4000/api/stats`

---

## 🌐 Deploying to GitHub & 24/7 Cloud Hosting

### Step 1: Push to GitHub
1. Create a new repository on [GitHub](https://github.com/new) named `qc-server-backend`.
2. In this directory (`QC Server Backend`), run:
```bash
git add .
git commit -m "feat: complete v2.1 backend with group chats, search, read receipts & docker"
git remote add origin https://github.com/YOUR_USERNAME/qc-server-backend.git
git branch -M main
git push -u origin main
```

### Step 2: 1-Click Cloud Deployments

#### Option A: Render.com (100% Free & Automatic)
1. Go to [Render Dashboard](https://dashboard.render.com/) and click **New** > **Web Service**.
2. Connect your `qc-server-backend` GitHub repository.
3. Render detects `render.yaml` automatically, or set:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
4. Click **Create Web Service**.
5. Render gives you an instant HTTPS URL (e.g. `https://qc-server-backend.onrender.com`).

#### Option B: Railway.app
1. Go to [Railway](https://railway.app/) and click **New Project** > **Deploy from GitHub repo**.
2. Select your `qc-server-backend` repository.
3. Railway automatically detects the included `Dockerfile` and deploys it.

#### Option C: Docker / VPS
Build and run anywhere with Docker:
```bash
docker build -t qc-server-backend .
docker run -d -p 4000:4000 -v $(pwd)/data:/app/data --name qc-server qc-server-backend
```

### Step 3: Connect QuantumConnect Frontend
1. Open the QuantumConnect app (Web or Android).
2. Go to **Settings** > **Backend Connection**.
3. Set your server URL (e.g. `https://qc-server-backend.onrender.com`).
4. All messages, calls, user accounts, and attachments will immediately stream through your cloud server!

---

## 📁 Persistent Storage Architecture (`data/`)

```
data/
├── users.json                   # Registered accounts & presence index
├── conversations.json           # Direct & group conversation metadata
├── messages.json                # Global message stream & reactions
├── calls.json                   # Call signaling logs & durations
└── users/                       # Per-user dedicated folders
    └── <username>/
        ├── profile.json         # User settings, bio & custom status
        ├── chats.json           # User's recent conversations summary
        ├── chats/
        │   └── <convId>.json    # User's individual chat archive
        ├── calls.json           # User's personal call history
        ├── starred.json         # User's starred messages
        └── media/               # User's uploaded media files
```

---

## ⚡ Socket.IO Event Reference

| Event Name | Direction | Payload | Description |
|------------|-----------|---------|-------------|
| `user:join` | Client ➔ Server | `{ userId, username }` | Register user socket and set online status |
| `user:presence` | Server ➔ Broadcast | `{ userId, username, status }` | Live online/offline state change broadcast |
| `user:status_update` | Server ➔ Broadcast | `{ userId, username, customStatus, moodEmoji }` | Broadcast custom user status change |
| `conversation:join` | Client ➔ Server | `{ conversationId }` | Join specific room for live chat stream |
| `conversation:leave` | Client ➔ Server | `{ conversationId }` | Leave conversation room |
| `message:new` | Client ➔ Server ➔ Broadcast | `{ conversationId, message }` | New message delivered in real-time |
| `message:update` | Server ➔ Broadcast | `{ conversationId, message }` | Message edited, deleted, or reacted |
| `message:read` | Client ➔ Server ➔ Broadcast | `{ conversationId, messageId, readerId }` | Read receipt broadcast |
| `message:pinned` | Server ➔ Broadcast | `{ conversationId, messageId, isPinned }` | Message pinned/unpinned notification |
| `typing:status` | Client ➔ Server ➔ Broadcast | `{ conversationId, userId, isTyping }` | Live typing indicator |
| `call:invite` | Client ➔ Server ➔ Peer | `{ callSession, offer }` | WebRTC incoming call signaling |
| `call:ringing` | Peer ➔ Server ➔ Caller | `{ callId }` | Incoming ringtone acknowledged |
| `call:accept` | Peer ➔ Server ➔ Caller | `{ callId, answer }` | WebRTC call answered with SDP answer |
| `call:candidate` | Client ↔ Peer | `{ callId, targetUserId, candidate }` | ICE Candidate exchange |
| `call:screen_share` | Client ➔ Peer | `{ callId, isSharing, peerId }` | Screen share toggle signal |
| `call:decline` | Peer ➔ Server ➔ Caller | `{ callId, callerId }` | Call declined |
| `call:end` | Either ➔ Server ➔ Peer | `{ callId, peerId, durationSeconds }` | Call terminated |
| `call:mesh_join` | Client ➔ Room | `{ roomId, user }` | Join multi-party mesh call |
| `call:mesh_signal` | Client ↔ Client | `{ targetSocketId, signal, fromUser }` | Relay mesh WebRTC peer signal |
| `call:mesh_leave` | Client ➔ Room | `{ roomId, userId }` | Leave multi-party mesh call |

---

## 🌐 REST API Endpoints

### System & Health
- `GET  /api/health` — Container & service health check.
- `GET  /api/stats` — Operational metrics (memory, connections, registered users, total messages).

### Authentication & Users
- `POST /api/auth/register` — Register user with immutable username and directory.
- `POST /api/auth/login` — Authenticate or auto-register user.
- `GET  /api/users` — Directory of all registered users with presence.
- `GET  /api/users/:username` — Detailed user profile and call count.
- `PUT  /api/users/:username` — Update display name, avatar, bio.
- `POST /api/users/:username/status` — Set custom status message and mood emoji.
- `GET  /api/users/:username/calls` — Personal call history.
- `GET  /api/users/:username/starred` — User's starred messages.
- `POST /api/users/:username/starred/:msgId` — Toggle starred message.

### Conversations & Groups
- `GET    /api/conversations?userId=:id` — Fetch user's active conversations.
- `POST   /api/conversations/direct` — Fetch or create 1-on-1 direct conversation.
- `POST   /api/conversations/group` — Create new group conversation.
- `PUT    /api/conversations/:id` — Update group name, description, avatar.
- `POST   /api/conversations/:id/participants` — Add member(s) to conversation.
- `DELETE /api/conversations/:id/participants/:userId` — Remove member or leave conversation.

### Messages
- `GET    /api/conversations/:id/messages` — Fetch message history (`?limit=100&before=timestamp`).
- `POST   /api/conversations/:id/messages` — Send new message with attachments/voice.
- `PUT    /api/conversations/:id/messages/:msgId` — Edit message text.
- `DELETE /api/conversations/:id/messages/:msgId` — Soft-delete message.
- `POST   /api/conversations/:id/messages/:msgId/reaction` — Toggle emoji reaction.
- `POST   /api/conversations/:id/messages/:msgId/pin` — Toggle message pin.
- `GET    /api/conversations/:id/pinned` — Get all pinned messages in conversation.
- `POST   /api/conversations/:id/read` — Mark conversation messages as read.

### Search & Media
- `GET    /api/search?q=:query&userId=:id` — Unified search across messages, conversations, and contacts.
- `POST   /api/upload` — Upload files, images, and audio voice notes.
- `DELETE /api/upload/:filename` — Delete uploaded file.

### Calls
- `GET  /api/calls/active` — Currently active WebRTC calls.
- `GET  /api/calls/history?userId=:id` — Query call history for user.

---

## 🧪 Testing & Verification

Run syntax checks and consistency validations:
```bash
npm test
```

Run Docker build locally:
```bash
docker build -t qc-server-backend .
```

---

## 📄 License

MIT © [QuantumConnect Team](https://github.com)
#   q c - s e r v e r - b a c k e n d  
 