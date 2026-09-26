/**
 * QuantumConnect — Dedicated Server Backend (v2.1)
 * Real-Time Messaging, Group Chats, WebRTC Audio/Video Signaling, User Presence & Storage
 * Stores all specific user data inside: data/users/<username>/
 */

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { db, userStorage, generateUniqueUsername, sanitizeUsername, USERS_DIR, UPLOADS_DIR } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const app = express();
const server = http.createServer(app);

// Configure Socket.IO with CORS & ping timeouts
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true,
  },
  pingTimeout: 30000,
  pingInterval: 15000,
});

// Middleware
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logger for diagnostic insights
app.use((req, res, next) => {
  if (req.path !== '/api/health') {
    const timestamp = new Date().toISOString().substring(11, 19);
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
  }
  next();
});

// Lightweight In-Memory Sliding-Window Rate Limiter
const rateLimitMap = new Map();
function rateLimiter(limit = 60, windowMs = 60000) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let record = rateLimitMap.get(ip);
    if (!record || now - record.startTime > windowMs) {
      record = { count: 1, startTime: now };
      rateLimitMap.set(ip, record);
    } else {
      record.count++;
      if (record.count > limit) {
        return res.status(429).json({ error: 'Too many requests, please slow down.' });
      }
    }
    next();
  };
}

// Clean up old rate limit records every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateLimitMap.entries()) {
    if (now - rec.startTime > 120000) rateLimitMap.delete(ip);
  }
}, 300000);

// Static uploads serving
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

// Dangerous file extensions guard
const FORBIDDEN_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.bin', '.msi', '.ps1', '.vbs', '.com', '.scr', '.pif'
]);

// Multer storage for attachments & media with user-directory routing
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const username = req.body.username || req.query.username;
    if (username) {
      const safeUser = sanitizeUsername(username);
      const userMediaDir = path.join(USERS_DIR, safeUser, 'media');
      if (!fs.existsSync(userMediaDir)) fs.mkdirSync(userMediaDir, { recursive: true });
    }
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (FORBIDDEN_EXTENSIONS.has(ext)) {
      return cb(new Error('Uploaded file type is not allowed for security reasons'));
    }
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `${base}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// Active user sockets map: identifier -> Set of socketIds
const userSockets = new Map();
const socketToUser = new Map();

// Helper to resolve user by ID, username, email, or Firebase UID
function resolveUser(identifier) {
  if (!identifier) return null;
  const idStr = String(identifier).toLowerCase().trim();
  return (
    db.users.findOne((u) => u.id === identifier || u.firebaseUid === identifier || (u.userId && u.userId === identifier)) ||
    db.users.findOne((u) => (u.username || '').toLowerCase() === idStr) ||
    db.users.findOne((u) => (u.email || '').toLowerCase() === idStr)
  );
}

// Auto-heal and reconstruct conversations from messages.json if missing from conversations.json
function healConversationsFromMessages() {
  try {
    const allMessages = db.messages.find();
    if (!allMessages || allMessages.length === 0) return;

    const convMap = new Map();
    allMessages.forEach((msg) => {
      if (!msg.conversationId) return;
      if (!convMap.has(msg.conversationId)) {
        convMap.set(msg.conversationId, []);
      }
      convMap.get(msg.conversationId).push(msg);
    });

    convMap.forEach((msgs, convId) => {
      msgs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      const firstMsg = msgs[0];
      const lastMsg = msgs[msgs.length - 1];

      let conv = db.conversations.findById(convId);
      if (!conv) {
        const participantsSet = new Set();
        const members = {};

        msgs.forEach((m) => {
          if (m.senderId) {
            participantsSet.add(m.senderId);
            const u = resolveUser(m.senderId);
            if (u) {
              if (u.id) participantsSet.add(u.id);
              if (u.firebaseUid) participantsSet.add(u.firebaseUid);
              if (u.username) participantsSet.add(u.username);
              if (u.email) participantsSet.add(u.email);
            }
            members[m.senderId] = {
              userId: m.senderId,
              username: u?.username || m.senderId,
              displayName: m.senderName || u?.displayName || 'User',
              avatarUrl: m.senderAvatar || u?.avatarUrl || '',
            };
          }
        });

        if (convId.startsWith('direct_')) {
          const parts = convId.replace(/^direct_/, '').split('_');
          parts.forEach((p) => {
            if (p) {
              participantsSet.add(p);
              const u = resolveUser(p);
              if (u) {
                if (u.id) participantsSet.add(u.id);
                if (u.firebaseUid) participantsSet.add(u.firebaseUid);
                if (u.username) participantsSet.add(u.username);
                if (u.email) participantsSet.add(u.email);
                if (!members[p]) {
                  members[p] = {
                    userId: u.id,
                    username: u.username,
                    displayName: u.displayName,
                    avatarUrl: u.avatarUrl,
                  };
                }
              }
            }
          });
        }

        db.conversations.insert({
          id: convId,
          type: convId.startsWith('group_') ? 'group' : 'direct',
          name: lastMsg.senderName || 'Conversation',
          avatarUrl: lastMsg.senderAvatar || '',
          participants: Array.from(participantsSet),
          members,
          unreadCount: 0,
          lastMessage: lastMsg,
          createdAt: firstMsg.timestamp || Date.now(),
          updatedAt: lastMsg.timestamp || Date.now(),
        });
        console.log(`[Auto-Heal] Successfully reconstructed conversation: ${convId} with ${msgs.length} messages`);
      } else {
        // Ensure participants and lastMessage are current
        const updates = {};
        if (!conv.lastMessage || (lastMsg.timestamp || 0) >= (conv.lastMessage.timestamp || 0)) {
          updates.lastMessage = lastMsg;
          updates.updatedAt = lastMsg.timestamp || conv.updatedAt || Date.now();
        }
        const pSet = new Set(conv.participants || []);
        msgs.forEach((m) => {
          if (m.senderId) {
            pSet.add(m.senderId);
            const u = resolveUser(m.senderId);
            if (u) {
              if (u.id) pSet.add(u.id);
              if (u.firebaseUid) pSet.add(u.firebaseUid);
              if (u.username) pSet.add(u.username);
              if (u.email) pSet.add(u.email);
            }
          }
        });
        updates.participants = Array.from(pSet);
        db.conversations.update(convId, updates);
      }
    });
  } catch (err) {
    console.warn('[Auto-Heal Notice]:', err.message);
  }
}

// Initial healing of conversations
healConversationsFromMessages();

// Sync existing users into dedicated user directories
try {
  const allUsers = db.users.find();
  allUsers.forEach((u) => {
    if (u.username) userStorage.saveProfile(u.username, u);
  });
} catch (err) {
  console.warn('[Sync Notice] User directory sync:', err.message);
}

// ==========================================
// REST API ROUTES
// ==========================================

// 0. Root Endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'QuantumConnect Dedicated Server Backend',
    version: '2.1.0',
    message: 'QuantumConnect 24/7 Cloud Backend is operational',
    endpoints: {
      health: '/api/health',
      stats: '/api/stats',
      users: '/api/users',
      conversations: '/api/conversations',
    },
  });
});

// 1. Health & Server Metrics
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'QuantumConnect Dedicated Server Backend',
    version: '2.1.0',
    uptime: Math.floor(process.uptime()),
    activeUsers: userSockets.size,
    timestamp: Date.now(),
  });
});

app.get('/api/stats', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    service: 'QuantumConnect Dedicated Server Backend',
    version: '2.1.0',
    uptimeSeconds: Math.floor(process.uptime()),
    nodeVersion: process.version,
    activeConnections: io.engine.clientsCount,
    onlineUsersCount: userSockets.size,
    totalRegisteredUsers: db.users.count(),
    totalConversations: db.conversations.count(),
    totalMessages: db.messages.count(),
    totalCallsLogged: db.calls.count(),
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    },
    timestamp: Date.now(),
  });
});

// 2. File Uploads
app.post('/api/upload', rateLimiter(100), (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'File upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const fileUrl = `${protocol}://${host}/uploads/${req.file.filename}`;

    // Also mirror to user's media folder
    const username = req.body.username || req.query.username;
    if (username) {
      const safeUser = sanitizeUsername(username);
      const userMediaDir = path.join(USERS_DIR, safeUser, 'media');
      if (!fs.existsSync(userMediaDir)) fs.mkdirSync(userMediaDir, { recursive: true });
      const dest = path.join(userMediaDir, req.file.filename);
      try {
        fs.copyFileSync(req.file.path, dest);
      } catch (copyErr) {
        console.warn('Could not mirror file to user media directory:', copyErr);
      }
    }

    res.json({
      url: fileUrl,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });
  });
});

// Delete uploaded file
app.delete('/api/upload/:filename', (req, res) => {
  const { filename } = req.params;
  const safeFilename = path.basename(filename);
  const filePath = path.join(UPLOADS_DIR, safeFilename);

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      return res.json({ success: true, message: 'File deleted' });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to delete file' });
    }
  }
  res.status(404).json({ error: 'File not found' });
});

// 3. Authentication & Profile
app.post('/api/auth/register', rateLimiter(30), (req, res) => {
  const { email, password, displayName, avatarUrl } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const existing = db.users.findOne((u) => u.email && u.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    userStorage.saveProfile(existing.username, existing);
    const { password: _, ...safeUser } = existing;
    return res.json({ user: safeUser, message: 'User already exists, logged in' });
  }

  const existingUsernames = db.users.find().map((u) => u.username).filter(Boolean);
  const username = generateUniqueUsername(email, existingUsernames);

  const user = db.users.insert({
    id: `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    email,
    password: password || 'pass123',
    displayName: displayName || username.replace(/_/g, ' '),
    username,
    avatarUrl: avatarUrl || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150',
    status: 'online',
    customStatus: 'Available',
    moodEmoji: '👋',
    lastSeen: Date.now(),
  });

  userStorage.saveProfile(username, user);
  console.log(`✨ Created dedicated user folder for: ${username} (${email})`);

  const { password: _, ...safeUser } = user;
  res.json({ user: safeUser });
});

app.post('/api/auth/login', rateLimiter(60), (req, res) => {
  const { email, password, displayName, avatarUrl } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email or username is required' });
  }

  let user = resolveUser(email);

  if (!user) {
    const existingUsernames = db.users.find().map((u) => u.username).filter(Boolean);
    const username = generateUniqueUsername(email, existingUsernames);

    user = db.users.insert({
      id: `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      email: email.includes('@') ? email : `${email}@gmail.com`,
      password: password || 'pass123',
      displayName: displayName || username.replace(/_/g, ' '),
      username,
      avatarUrl: avatarUrl || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150',
      status: 'online',
      customStatus: 'Available',
      moodEmoji: '👋',
      lastSeen: Date.now(),
    });
  } else {
    const updates = { status: 'online', lastSeen: Date.now() };
    if (displayName && (!user.displayName || user.displayName === user.username)) {
      updates.displayName = displayName;
    }
    if (avatarUrl && !user.avatarUrl) updates.avatarUrl = avatarUrl;
    user = db.users.update(user.id, updates);
  }

  userStorage.saveProfile(user.username, user);
  const { password: _, ...safeUser } = user;
  res.json({ user: safeUser });
});

// 4. Contacts & Users Directory
app.get('/api/users', (req, res) => {
  const users = db.users.find().map(({ password, ...u }) => ({
    userId: u.id,
    id: u.id,
    email: u.email,
    displayName: u.displayName || u.username,
    username: u.username,
    avatarUrl: u.avatarUrl,
    status: userSockets.has(u.id) || userSockets.has(u.username) ? 'online' : u.status || 'offline',
    customStatus: u.customStatus || '',
    moodEmoji: u.moodEmoji || '',
    lastSeen: u.lastSeen || Date.now(),
    connectionStatus: 'connected',
  }));
  res.json({ users });
});

app.get('/api/users/:username', (req, res) => {
  const { username } = req.params;
  const user = resolveUser(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const profile = userStorage.getProfile(user.username) || user;
  const calls = userStorage.getCalls(user.username);
  const { password: _, ...safeUser } = profile;
  res.json({ user: safeUser, callsCount: calls.length });
});

// Update profile (bio, displayName, avatarUrl)
app.put('/api/users/:username', (req, res) => {
  const { username } = req.params;
  const user = resolveUser(username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { displayName, avatarUrl, bio } = req.body;
  const updates = {};
  if (displayName) updates.displayName = displayName;
  if (avatarUrl) updates.avatarUrl = avatarUrl;
  if (bio !== undefined) updates.bio = bio;

  const updated = db.users.update(user.id, updates);
  userStorage.saveProfile(user.username, updates);

  io.emit('user:profile_updated', { userId: user.id, username: user.username, ...updates });
  const { password: _, ...safeUser } = updated;
  res.json({ user: safeUser });
});

// Custom status update (e.g. "Coding", "In a meeting")
app.post('/api/users/:username/status', (req, res) => {
  const { username } = req.params;
  const user = resolveUser(username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { statusText, moodEmoji } = req.body;
  const updated = db.users.update(user.id, {
    customStatus: statusText || '',
    moodEmoji: moodEmoji || '',
  });
  userStorage.saveStatus(user.username, statusText, moodEmoji);

  io.emit('user:status_update', {
    userId: user.id,
    username: user.username,
    customStatus: statusText,
    moodEmoji,
  });

  res.json({ success: true, customStatus: statusText, moodEmoji });
});

// Starred messages
app.get('/api/users/:username/starred', (req, res) => {
  const { username } = req.params;
  const user = resolveUser(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const starred = userStorage.getStarred(user.username);
  res.json({ starred });
});

app.post('/api/users/:username/starred/:msgId', (req, res) => {
  const { username, msgId } = req.params;
  const user = resolveUser(username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const message = db.messages.findById(msgId);
  if (!message) return res.status(404).json({ error: 'Message not found' });

  const result = userStorage.toggleStarred(user.username, message);
  res.json(result);
});

// Specific user calls log
app.get('/api/users/:username/calls', (req, res) => {
  const { username } = req.params;
  const user = resolveUser(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const calls = userStorage.getCalls(user.username);
  res.json({ calls });
});

// 5. Conversations (Direct & Group)
app.get('/api/conversations', (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: 'userId query parameter is required' });
  }

  // Ensure any orphaned messages have their conversations reconstructed
  healConversationsFromMessages();

  const user = resolveUser(userId);
  const userKeys = new Set([userId, String(userId).toLowerCase()]);
  if (user) {
    if (user.id) userKeys.add(user.id);
    if (user.firebaseUid) userKeys.add(user.firebaseUid);
    if (user.username) {
      userKeys.add(user.username);
      userKeys.add(user.username.toLowerCase());
    }
    if (user.email) {
      userKeys.add(user.email);
      userKeys.add(user.email.toLowerCase());
    }
  }

  const keysArray = Array.from(userKeys);
  const conversations = db.conversations
    .find((c) => {
      if (!c.participants) return false;
      return c.participants.some((p) => {
        const pStr = String(p).toLowerCase();
        return keysArray.includes(p) || keysArray.includes(pStr);
      });
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  res.json({ conversations });
});

// Direct 1-on-1 conversation
app.post('/api/conversations/direct', (req, res) => {
  const { currentUserId, targetUser } = req.body;
  if (!currentUserId || !targetUser || (!targetUser.id && !targetUser.username)) {
    return res.status(400).json({ error: 'currentUserId and targetUser are required' });
  }

  const sender = resolveUser(currentUserId) || {
    id: currentUserId,
    username: currentUserId,
    displayName: 'User',
    avatarUrl: '',
  };
  const receiver = resolveUser(targetUser.id || targetUser.username) || {
    id: targetUser.id || targetUser.username,
    username: targetUser.username || targetUser.id,
    displayName: targetUser.displayName || 'User',
    avatarUrl: targetUser.avatarUrl || '',
  };

  const sortedUsernames = [sender.username, receiver.username].sort();
  const convId = `direct_${sortedUsernames[0]}_${sortedUsernames[1]}`;

  let conv = db.conversations.findById(convId);

  if (!conv) {
    conv = db.conversations.insert({
      id: convId,
      type: 'direct',
      name: receiver.displayName,
      avatarUrl: receiver.avatarUrl,
      participants: [sender.id, receiver.id, sender.username, receiver.username],
      members: {
        [sender.id]: {
          userId: sender.id,
          username: sender.username,
          displayName: sender.displayName,
          avatarUrl: sender.avatarUrl,
        },
        [receiver.id]: {
          userId: receiver.id,
          username: receiver.username,
          displayName: receiver.displayName,
          avatarUrl: receiver.avatarUrl,
        },
      },
      unreadCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  } else {
    conv.members[receiver.id] = {
      userId: receiver.id,
      username: receiver.username,
      displayName: receiver.displayName,
      avatarUrl: receiver.avatarUrl,
    };
    db.conversations.update(convId, { members: conv.members });
  }

  res.json({ conversation: conv });
});

// Group conversation creation
app.post('/api/conversations/group', (req, res) => {
  const { name, description, avatarUrl, createdBy, members } = req.body;
  if (!name || !createdBy || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'name, createdBy, and members array are required' });
  }

  const creator = resolveUser(createdBy) || { id: createdBy, username: createdBy, displayName: 'Admin' };
  const allParticipantIds = new Set([creator.id, creator.username]);
  const membersMap = {
    [creator.id]: {
      userId: creator.id,
      username: creator.username,
      displayName: creator.displayName,
      avatarUrl: creator.avatarUrl || '',
      role: 'admin',
    },
  };

  members.forEach((m) => {
    const u = resolveUser(m.id || m.userId || m.username || m);
    const mId = u ? u.id : (m.id || m.userId || m);
    const mUsername = u ? u.username : (m.username || mId);
    allParticipantIds.add(mId);
    if (mUsername) allParticipantIds.add(mUsername);

    membersMap[mId] = {
      userId: mId,
      username: mUsername,
      displayName: u ? u.displayName : (m.displayName || mUsername),
      avatarUrl: u ? u.avatarUrl : (m.avatarUrl || ''),
      role: m.role || 'member',
    };
  });

  const convId = `group_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const groupConv = db.conversations.insert({
    id: convId,
    type: 'group',
    name,
    description: description || '',
    avatarUrl: avatarUrl || 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=150',
    adminId: creator.id,
    participants: Array.from(allParticipantIds),
    members: membersMap,
    unreadCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // Broadcast to all group members
  groupConv.participants.forEach((pKey) => {
    io.to(`user_${pKey}`).emit('conversation:created', { conversation: groupConv });
  });

  res.json({ conversation: groupConv });
});

// Update group details
app.put('/api/conversations/:id', (req, res) => {
  const { id } = req.params;
  const { name, description, avatarUrl } = req.body;

  const conv = db.conversations.findById(id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const updates = {};
  if (name) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (avatarUrl) updates.avatarUrl = avatarUrl;
  updates.updatedAt = Date.now();

  const updated = db.conversations.update(id, updates);
  io.to(`conv_${id}`).emit('conversation:updated', { conversation: updated });

  res.json({ conversation: updated });
});

// Add members to group
app.post('/api/conversations/:id/participants', (req, res) => {
  const { id } = req.params;
  const { members } = req.body;

  const conv = db.conversations.findById(id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const participants = new Set(conv.participants || []);
  const membersMap = conv.members || {};

  (members || []).forEach((m) => {
    const u = resolveUser(m.id || m.userId || m.username || m);
    const mId = u ? u.id : (m.id || m.userId || m);
    const mUsername = u ? u.username : (m.username || mId);
    participants.add(mId);
    if (mUsername) participants.add(mUsername);

    membersMap[mId] = {
      userId: mId,
      username: mUsername,
      displayName: u ? u.displayName : (m.displayName || mUsername),
      avatarUrl: u ? u.avatarUrl : (m.avatarUrl || ''),
      role: 'member',
    };
  });

  const updated = db.conversations.update(id, {
    participants: Array.from(participants),
    members: membersMap,
    updatedAt: Date.now(),
  });

  io.to(`conv_${id}`).emit('conversation:updated', { conversation: updated });
  res.json({ conversation: updated });
});

// Remove participant / leave conversation
app.delete('/api/conversations/:id/participants/:userId', (req, res) => {
  const { id, userId } = req.params;
  const conv = db.conversations.findById(id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const u = resolveUser(userId);
  const targetIds = [userId, u?.id, u?.username].filter(Boolean);

  const participants = (conv.participants || []).filter((p) => !targetIds.includes(p));
  const members = { ...conv.members };
  targetIds.forEach((tid) => delete members[tid]);

  const updated = db.conversations.update(id, {
    participants,
    members,
    updatedAt: Date.now(),
  });

  io.to(`conv_${id}`).emit('conversation:member_left', { conversationId: id, userId });
  io.to(`conv_${id}`).emit('conversation:updated', { conversation: updated });

  res.json({ conversation: updated });
});

// 6. Messages Management
app.get('/api/conversations/:id/messages', (req, res) => {
  const { id } = req.params;
  const limit = parseInt(req.query.limit) || 100;
  const before = parseInt(req.query.before) || Infinity;

  let messages = db.messages
    .find((m) => m.conversationId === id && (m.timestamp || 0) < before)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  if (messages.length > limit) {
    messages = messages.slice(-limit);
  }

  res.json({ messages });
});

app.post('/api/conversations/:id/messages', (req, res) => {
  const { id } = req.params;
  const messageData = req.body;

  const msgId = messageData.id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const newMessage = {
    ...messageData,
    id: msgId,
    conversationId: id,
    timestamp: messageData.timestamp || Date.now(),
    status: 'delivered',
    readBy: [messageData.senderId].filter(Boolean),
  };

  // 1. Insert into global db.messages
  db.messages.insert(newMessage);

  // 2. Update or insert conversation summary
  let conv = db.conversations.findById(id);
  if (conv) {
    db.conversations.update(id, {
      lastMessage: newMessage,
      updatedAt: newMessage.timestamp,
    });
    conv = db.conversations.findById(id);
  } else {
    // Reconstruct/auto-create conversation so it is immediately visible in conversations list
    const participants = [newMessage.senderId];
    if (id.startsWith('direct_')) {
      const parts = id.replace(/^direct_/, '').split('_');
      parts.forEach((p) => { if (p && !participants.includes(p)) participants.push(p); });
    }
    conv = db.conversations.insert({
      id,
      type: id.startsWith('group_') ? 'group' : 'direct',
      name: newMessage.senderName || 'Chat',
      avatarUrl: newMessage.senderAvatar || '',
      participants,
      members: {
        [newMessage.senderId]: {
          userId: newMessage.senderId,
          displayName: newMessage.senderName,
          avatarUrl: newMessage.senderAvatar,
        },
      },
      lastMessage: newMessage,
      unreadCount: 0,
      createdAt: newMessage.timestamp,
      updatedAt: newMessage.timestamp,
    });
  }

  // 3. Persist to participants' dedicated user folders
  if (conv && conv.participants) {
    conv.participants.forEach((pKey) => {
      const u = resolveUser(pKey);
      if (u && u.username) {
        userStorage.saveMessage(u.username, id, newMessage);
      }
    });
  }

  // 4. Real-time emit to conversation room and directly to user rooms
  io.to(`conv_${id}`).emit('message:new', { conversationId: id, message: newMessage });

  if (conv && conv.participants) {
    conv.participants.forEach((pKey) => {
      io.to(`user_${pKey}`).emit('message:new', { conversationId: id, message: newMessage });
      io.to(`user_${pKey}`).emit('conversation:updated', { conversationId: id, lastMessage: newMessage });
    });
  }

  res.json({ message: newMessage });
});

// Edit message
app.put('/api/conversations/:id/messages/:msgId', (req, res) => {
  const { id, msgId } = req.params;
  const { text } = req.body;

  const updated = db.messages.update(msgId, {
    text,
    isEdited: true,
    editedAt: Date.now(),
  });

  if (updated) {
    io.to(`conv_${id}`).emit('message:update', { conversationId: id, message: updated });
    const conv = db.conversations.findById(id);
    if (conv && conv.participants) {
      conv.participants.forEach((pKey) => {
        io.to(`user_${pKey}`).emit('message:update', { conversationId: id, message: updated });
        const u = resolveUser(pKey);
        if (u && u.username) {
          userStorage.updateMessage(u.username, id, msgId, { text, isEdited: true });
        }
      });
    }
  }

  res.json({ message: updated });
});

// Delete message
app.delete('/api/conversations/:id/messages/:msgId', (req, res) => {
  const { id, msgId } = req.params;

  const updated = db.messages.update(msgId, {
    text: 'This message was deleted',
    isDeleted: true,
    attachmentUrl: null,
  });

  if (updated) {
    io.to(`conv_${id}`).emit('message:update', { conversationId: id, message: updated });
    const conv = db.conversations.findById(id);
    if (conv && conv.participants) {
      conv.participants.forEach((pKey) => {
        io.to(`user_${pKey}`).emit('message:update', { conversationId: id, message: updated });
        const u = resolveUser(pKey);
        if (u && u.username) {
          userStorage.updateMessage(u.username, id, msgId, {
            text: 'This message was deleted',
            isDeleted: true,
            attachmentUrl: null,
          });
        }
      });
    }
  }

  res.json({ message: updated });
});

// Emoji reaction toggle
app.post('/api/conversations/:id/messages/:msgId/reaction', (req, res) => {
  const { id, msgId } = req.params;
  const { emoji, userId } = req.body;

  const msg = db.messages.findById(msgId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const reactions = msg.reactions || {};
  const existing = reactions[emoji] || [];

  if (existing.includes(userId)) {
    reactions[emoji] = existing.filter((uid) => uid !== userId);
    if (reactions[emoji].length === 0) delete reactions[emoji];
  } else {
    reactions[emoji] = [...existing, userId];
  }

  const updated = db.messages.update(msgId, { reactions });
  io.to(`conv_${id}`).emit('message:update', { conversationId: id, message: updated });

  res.json({ message: updated });
});

// Message Pinning
app.post('/api/conversations/:id/messages/:msgId/pin', (req, res) => {
  const { id, msgId } = req.params;
  const msg = db.messages.findById(msgId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const isPinned = !msg.isPinned;
  const updated = db.messages.update(msgId, {
    isPinned,
    pinnedAt: isPinned ? Date.now() : null,
  });

  io.to(`conv_${id}`).emit('message:pinned', { conversationId: id, messageId: msgId, isPinned });
  io.to(`conv_${id}`).emit('message:update', { conversationId: id, message: updated });

  res.json({ message: updated, isPinned });
});

app.get('/api/conversations/:id/pinned', (req, res) => {
  const { id } = req.params;
  const pinned = db.messages.find((m) => m.conversationId === id && m.isPinned);
  res.json({ pinned });
});

// Read Receipts endpoint
app.post('/api/conversations/:id/read', (req, res) => {
  const { id } = req.params;
  const { userId, messageId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const unreadMessages = db.messages.find(
    (m) => m.conversationId === id && (!m.readBy || !m.readBy.includes(userId))
  );

  unreadMessages.forEach((m) => {
    const readBy = m.readBy ? [...m.readBy, userId] : [userId];
    db.messages.update(m.id, { readBy, status: 'read' });
  });

  io.to(`conv_${id}`).emit('message:read', {
    conversationId: id,
    readerId: userId,
    messageId,
    readAt: Date.now(),
  });

  res.json({ success: true, count: unreadMessages.length });
});

// 7. Global Search (Messages, Conversations, Users)
app.get('/api/search', (req, res) => {
  const query = (req.query.q || '').toLowerCase().trim();
  const userId = req.query.userId;

  if (!query || query.length < 2) {
    return res.json({ messages: [], conversations: [], users: [] });
  }

  // Search users
  const matchedUsers = db.users
    .find(
      (u) =>
        (u.displayName && u.displayName.toLowerCase().includes(query)) ||
        (u.username && u.username.toLowerCase().includes(query)) ||
        (u.email && u.email.toLowerCase().includes(query))
    )
    .slice(0, 10)
    .map(({ password, ...safe }) => safe);

  // Search user's conversations
  let userConversations = db.conversations.find();
  if (userId) {
    const user = resolveUser(userId);
    const uKeys = [userId, user?.id, user?.username].filter(Boolean);
    userConversations = userConversations.filter((c) =>
      c.participants && c.participants.some((p) => uKeys.includes(p))
    );
  }
  const matchedConversations = userConversations
    .filter((c) => c.name && c.name.toLowerCase().includes(query))
    .slice(0, 10);

  // Search messages within accessible conversations
  const allowedConvIds = new Set(userConversations.map((c) => c.id));
  const matchedMessages = db.messages
    .find((m) => allowedConvIds.has(m.conversationId) && m.text && m.text.toLowerCase().includes(query))
    .slice(0, 20);

  res.json({
    users: matchedUsers,
    conversations: matchedConversations,
    messages: matchedMessages,
  });
});

// 8. Calls Management
app.get('/api/calls/active', (req, res) => {
  const activeCalls = db.calls.find((c) => c.status === 'calling' || c.status === 'ringing' || c.status === 'connected');
  res.json({ calls: activeCalls });
});

app.get('/api/calls/history', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const user = resolveUser(userId);
  const uKeys = [userId, user?.id, user?.username].filter(Boolean);

  const history = db.calls
    .find((c) => uKeys.includes(c.callerId) || uKeys.includes(c.receiverId))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

  res.json({ calls: history });
});

// ==========================================
// SOCKET.IO REAL-TIME & WEBRTC SIGNALING
// ==========================================

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // User online registration
  socket.on('user:join', ({ userId, username }) => {
    const user = resolveUser(userId || username);
    const resolvedId = user ? user.id : userId;
    const resolvedUsername = user ? user.username : username;

    if (resolvedId) {
      socketToUser.set(socket.id, resolvedId);
      if (!userSockets.has(resolvedId)) userSockets.set(resolvedId, new Set());
      userSockets.get(resolvedId).add(socket.id);
      socket.join(`user_${resolvedId}`);
    }

    if (resolvedUsername) {
      socket.join(`user_${resolvedUsername}`);
      socket.join(`username_${resolvedUsername}`);
      if (!userSockets.has(resolvedUsername)) userSockets.set(resolvedUsername, new Set());
      userSockets.get(resolvedUsername).add(socket.id);
    }

    if (user) {
      db.users.update(user.id, { status: 'online', lastSeen: Date.now() });
      userStorage.saveProfile(user.username, { status: 'online', lastSeen: Date.now() });
      io.emit('user:presence', { userId: user.id, username: user.username, status: 'online' });
      console.log(`👤 User joined: ${user.username} (${user.id})`);
    }
  });

  // Join a conversation room
  socket.on('conversation:join', ({ conversationId }) => {
    if (conversationId) {
      socket.join(`conv_${conversationId}`);
    }
  });

  // Leave a conversation room
  socket.on('conversation:leave', ({ conversationId }) => {
    if (conversationId) {
      socket.leave(`conv_${conversationId}`);
    }
  });

  // Typing status broadcast
  socket.on('typing:status', ({ conversationId, userId, isTyping }) => {
    socket.to(`conv_${conversationId}`).emit('typing:status', { conversationId, userId, isTyping });
  });

  // Read status broadcast
  socket.on('message:read', ({ conversationId, messageId, userId }) => {
    io.to(`conv_${conversationId}`).emit('message:read', {
      conversationId,
      messageId,
      readerId: userId,
      readAt: Date.now(),
    });
  });

  // Heartbeat ping
  socket.on('heartbeat', (data) => {
    socket.emit('heartbeat:ack', { timestamp: Date.now() });
  });

  // --- WebRTC Voice / Video Call Signaling ---

  // Caller initiates call invite
  socket.on('call:invite', ({ callSession, offer }) => {
    const caller = resolveUser(callSession.callerId) || { id: callSession.callerId, username: callSession.callerId };
    const receiver = resolveUser(callSession.receiverId) || { id: callSession.receiverId, username: callSession.receiverId };

    console.log(`📞 Call invite from ${caller.username || caller.id} to ${receiver.username || receiver.id}`);

    const enrichedSession = {
      ...callSession,
      callerUsername: caller.username,
      receiverUsername: receiver.username,
      status: 'calling',
      startedAt: Date.now(),
    };

    db.calls.upsert(callSession.id, {
      ...enrichedSession,
      offer,
    });

    if (caller.username) {
      userStorage.recordCall(caller.username, {
        id: callSession.id,
        direction: 'outgoing',
        peerId: receiver.id,
        peerUsername: receiver.username,
        peerDisplayName: callSession.receiverName,
        peerAvatar: callSession.receiverAvatar,
        type: callSession.type,
        status: 'calling',
        startedAt: enrichedSession.startedAt,
      });
    }
    if (receiver.username) {
      userStorage.recordCall(receiver.username, {
        id: callSession.id,
        direction: 'incoming',
        peerId: caller.id,
        peerUsername: caller.username,
        peerDisplayName: callSession.callerName,
        peerAvatar: callSession.callerAvatar,
        type: callSession.type,
        status: 'ringing',
        startedAt: enrichedSession.startedAt,
      });
    }

    const targets = [
      `user_${callSession.receiverId}`,
      receiver.username ? `user_${receiver.username}` : null,
      receiver.id ? `user_${receiver.id}` : null,
    ].filter(Boolean);

    targets.forEach((t) => {
      io.to(t).emit('call:invite', {
        callSession: enrichedSession,
        offer,
      });
    });
  });

  // Receiver acknowledges ringing
  socket.on('call:ringing', ({ callId }) => {
    const call = db.calls.findById(callId);
    if (call) {
      db.calls.update(callId, { status: 'ringing' });
      io.to(`user_${call.callerId}`).emit('call:ringing', { callId });
      if (call.callerUsername) io.to(`user_${call.callerUsername}`).emit('call:ringing', { callId });
    }
  });

  // Receiver accepts call with SDP answer
  socket.on('call:accept', ({ callId, answer }) => {
    console.log(`✅ Call accepted: ${callId}`);
    const call = db.calls.findById(callId);
    if (call) {
      db.calls.update(callId, {
        status: 'connected',
        answer,
        connectedAt: Date.now(),
      });

      if (call.callerUsername) {
        userStorage.recordCall(call.callerUsername, { id: callId, status: 'connected', connectedAt: Date.now() });
      }
      if (call.receiverUsername) {
        userStorage.recordCall(call.receiverUsername, { id: callId, status: 'connected', connectedAt: Date.now() });
      }

      io.to(`user_${call.callerId}`).emit('call:accept', { callId, answer });
      if (call.callerUsername) io.to(`user_${call.callerUsername}`).emit('call:accept', { callId, answer });
    }
  });

  // ICE Candidate relay
  socket.on('call:candidate', ({ callId, targetUserId, candidate }) => {
    if (targetUserId) {
      const target = resolveUser(targetUserId);
      io.to(`user_${targetUserId}`).emit('call:candidate', { callId, candidate });
      if (target && target.username) {
        io.to(`user_${target.username}`).emit('call:candidate', { callId, candidate });
      }
    }
  });

  // Screen sharing toggle signal
  socket.on('call:screen_share', ({ callId, isSharing, peerId }) => {
    if (peerId) {
      io.to(`user_${peerId}`).emit('call:screen_share', { callId, isSharing });
    }
  });

  // Receiver declines call
  socket.on('call:decline', ({ callId, callerId }) => {
    console.log(`❌ Call declined: ${callId}`);
    const call = db.calls.findById(callId);
    db.calls.update(callId, { status: 'declined', endedAt: Date.now() });

    if (call) {
      if (call.callerUsername) {
        userStorage.recordCall(call.callerUsername, { id: callId, status: 'declined', endedAt: Date.now() });
      }
      if (call.receiverUsername) {
        userStorage.recordCall(call.receiverUsername, { id: callId, status: 'declined', endedAt: Date.now() });
      }
    }

    if (callerId) {
      io.to(`user_${callerId}`).emit('call:decline', { callId });
    }
    if (call && call.callerUsername) {
      io.to(`user_${call.callerUsername}`).emit('call:decline', { callId });
    }
  });

  // Either party ends call
  socket.on('call:end', ({ callId, peerId, durationSeconds }) => {
    console.log(`⏹️ Call ended: ${callId}`);
    const call = db.calls.findById(callId);
    const endedAt = Date.now();
    db.calls.update(callId, { status: 'ended', endedAt, durationSeconds });

    if (call) {
      if (call.callerUsername) {
        userStorage.recordCall(call.callerUsername, { id: callId, status: 'ended', endedAt, durationSeconds });
      }
      if (call.receiverUsername) {
        userStorage.recordCall(call.receiverUsername, { id: callId, status: 'ended', endedAt, durationSeconds });
      }
    }

    if (peerId) {
      const peer = resolveUser(peerId);
      io.to(`user_${peerId}`).emit('call:end', { callId });
      if (peer && peer.username) {
        io.to(`user_${peer.username}`).emit('call:end', { callId });
      }
    }
  });

  // Multi-party / Mesh Call Signaling
  socket.on('call:mesh_join', ({ roomId, user }) => {
    socket.join(`mesh_${roomId}`);
    socket.to(`mesh_${roomId}`).emit('call:mesh_user_joined', { roomId, user, socketId: socket.id });
  });

  socket.on('call:mesh_signal', ({ targetSocketId, signal, fromUser }) => {
    io.to(targetSocketId).emit('call:mesh_signal', { signal, fromSocketId: socket.id, fromUser });
  });

  socket.on('call:mesh_leave', ({ roomId, userId }) => {
    socket.leave(`mesh_${roomId}`);
    socket.to(`mesh_${roomId}`).emit('call:mesh_user_left', { roomId, userId, socketId: socket.id });
  });

  // Disconnection handler
  socket.on('disconnect', () => {
    const userId = socketToUser.get(socket.id);
    if (userId) {
      socketToUser.delete(socket.id);
      const userSet = userSockets.get(userId);
      if (userSet) {
        userSet.delete(socket.id);
        if (userSet.size === 0) {
          userSockets.delete(userId);
          const u = resolveUser(userId);
          if (u) {
            db.users.update(u.id, { status: 'offline', lastSeen: Date.now() });
            userStorage.saveProfile(u.username, { status: 'offline', lastSeen: Date.now() });
            io.emit('user:presence', { userId: u.id, username: u.username, status: 'offline' });
          }
        }
      }
    }
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// Graceful shutdown
function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal}. Gracefully shutting down QuantumConnect Backend...`);
  server.close(() => {
    console.log('✅ HTTP and WebSocket server closed cleanly.');
    process.exit(0);
  });
  // Force shutdown after 10s if sockets linger
  setTimeout(() => {
    console.error('⚠️ Forcing shutdown after timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║   🚀 QuantumConnect Dedicated Backend Server Running (v2.1)       ║
║   Port:    ${PORT}                                                   ║
║   Local:   http://localhost:${PORT}                               ║
║   Network: http://0.0.0.0:${PORT}                                 ║
║   Health:  http://localhost:${PORT}/api/health                    ║
║   Stats:   http://localhost:${PORT}/api/stats                     ║
║   Storage: Dedicated Per-User Folders in data/users/<username>/   ║
║   Status:  Ready for Real-Time Messages, Calls & Storage          ║
╚═══════════════════════════════════════════════════════════════════╝
  `);
});
