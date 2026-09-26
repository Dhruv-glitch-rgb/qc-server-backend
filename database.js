/**
 * QuantumConnect Server — Persistent Storage Engine (v2.1)
 * High-performance atomic JSON file-based database with memory caching
 * Supports dedicated per-user directory architecture:
 * data/users/<username>/
 *   ├── profile.json
 *   ├── chats.json
 *   ├── chats/<conversationId>.json
 *   ├── calls.json
 *   ├── starred.json
 *   └── media/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DATA_DIR = path.join(__dirname, 'data');
export const USERS_DIR = path.join(DATA_DIR, 'users');
export const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure root directories exist
[DATA_DIR, USERS_DIR, UPLOADS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

/**
 * Write file atomically using temp file and rename to prevent corruption
 */
function writeJsonFileSync(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 6)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {}
    }
    // Direct write fallback
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e2) {
      console.error(`[DB Error] Failed to write file ${filePath}:`, e2);
    }
  }
}

/**
 * Safely sanitize usernames to avoid directory traversal
 */
export function sanitizeUsername(username) {
  if (!username) return 'user';
  return String(username)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '') || 'user';
}

/**
 * Generate a clean, unique, immutable username derived from Gmail / email ID
 */
export function generateUniqueUsername(email, existingUsernames = []) {
  if (!email) email = 'user';
  let base = email.split('@')[0].toLowerCase().trim();
  base = base.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!base || base.length < 2) base = 'user';

  const lowerSet = new Set(existingUsernames.map((u) => (u || '').toLowerCase()));
  let candidate = base;
  let counter = 1;

  while (lowerSet.has(candidate)) {
    candidate = `${base}_${counter}`;
    counter++;
  }

  return candidate;
}

/**
 * Generic Collection with memory cache and synchronous atomic JSON persistence
 */
export class Collection {
  constructor(name) {
    this.name = name;
    this.filePath = path.join(DATA_DIR, `${name}.json`);
    this.items = [];
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.items = JSON.parse(raw);
      } else {
        this.items = [];
        this.save();
      }
    } catch (err) {
      console.error(`[DB Error] Loading collection ${this.name}:`, err);
      // Attempt backup recovery if exists
      const bakPath = `${this.filePath}.bak`;
      if (fs.existsSync(bakPath)) {
        try {
          this.items = JSON.parse(fs.readFileSync(bakPath, 'utf-8'));
          console.warn(`[DB Recovery] Restored collection ${this.name} from backup!`);
        } catch (_) {
          this.items = [];
        }
      } else {
        this.items = [];
      }
    }
  }

  save() {
    // Keep a rolling backup
    if (this.items.length > 0) {
      try {
        fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
      } catch (_) {}
    }
    writeJsonFileSync(this.filePath, this.items);
  }

  find(predicate) {
    if (!predicate) return [...this.items];
    return this.items.filter(predicate);
  }

  findOne(predicate) {
    return this.items.find(predicate) || null;
  }

  findById(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  count(predicate) {
    if (!predicate) return this.items.length;
    return this.items.filter(predicate).length;
  }

  insert(item) {
    const newItem = {
      ...item,
      id: item.id || `id_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      createdAt: item.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    this.items.push(newItem);
    this.save();
    return newItem;
  }

  update(id, updates) {
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx === -1) return null;

    this.items[idx] = {
      ...this.items[idx],
      ...updates,
      updatedAt: Date.now(),
    };
    this.save();
    return this.items[idx];
  }

  upsert(id, item) {
    const existing = this.findById(id);
    if (existing) {
      return this.update(id, item);
    } else {
      return this.insert({ ...item, id });
    }
  }

  delete(id) {
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    this.save();
    return true;
  }
}

/**
 * Dedicated User Directory Storage Manager
 * Stores all specific user data inside: data/users/<username>/
 */
export const userStorage = {
  getUserDir(username) {
    if (!username) return null;
    const safeUsername = sanitizeUsername(username);
    const userDir = path.join(USERS_DIR, safeUsername);

    // Verify path stays within USERS_DIR for security
    const resolvedPath = path.resolve(userDir);
    if (!resolvedPath.startsWith(path.resolve(USERS_DIR))) {
      console.warn(`[Security Alert] Blocked directory traversal attempt: ${username}`);
      return null;
    }

    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    const chatsDir = path.join(userDir, 'chats');
    if (!fs.existsSync(chatsDir)) fs.mkdirSync(chatsDir, { recursive: true });
    const mediaDir = path.join(userDir, 'media');
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

    return {
      userDir,
      chatsDir,
      mediaDir,
      profileFile: path.join(userDir, 'profile.json'),
      chatsFile: path.join(userDir, 'chats.json'),
      callsFile: path.join(userDir, 'calls.json'),
      starredFile: path.join(userDir, 'starred.json'),
    };
  },

  saveProfile(username, profileData) {
    const paths = this.getUserDir(username);
    if (!paths) return null;
    try {
      const existing = this.getProfile(username) || {};
      const updated = {
        ...existing,
        ...profileData,
        username,
        updatedAt: Date.now(),
      };
      writeJsonFileSync(paths.profileFile, updated);
      return updated;
    } catch (err) {
      console.error(`[DB Error] Saving profile for ${username}:`, err);
      return null;
    }
  },

  getProfile(username) {
    const paths = this.getUserDir(username);
    if (!paths || !fs.existsSync(paths.profileFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(paths.profileFile, 'utf-8'));
    } catch {
      return null;
    }
  },

  saveStatus(username, statusText, moodEmoji) {
    const paths = this.getUserDir(username);
    if (!paths) return null;
    const existing = this.getProfile(username) || {};
    const updated = {
      ...existing,
      customStatus: statusText,
      moodEmoji: moodEmoji || '',
      statusUpdatedAt: Date.now(),
    };
    writeJsonFileSync(paths.profileFile, updated);
    return updated;
  },

  recordCall(username, callData) {
    const paths = this.getUserDir(username);
    if (!paths) return;
    try {
      let calls = [];
      if (fs.existsSync(paths.callsFile)) {
        try {
          calls = JSON.parse(fs.readFileSync(paths.callsFile, 'utf-8'));
        } catch {
          calls = [];
        }
      }
      const existingIdx = calls.findIndex((c) => c.id === callData.id);
      if (existingIdx !== -1) {
        calls[existingIdx] = { ...calls[existingIdx], ...callData, updatedAt: Date.now() };
      } else {
        calls.unshift({
          ...callData,
          recordedAt: Date.now(),
        });
      }
      writeJsonFileSync(paths.callsFile, calls.slice(0, 100)); // Keep last 100 calls
    } catch (err) {
      console.error(`[DB Error] Recording call for ${username}:`, err);
    }
  },

  getCalls(username) {
    const paths = this.getUserDir(username);
    if (!paths || !fs.existsSync(paths.callsFile)) return [];
    try {
      return JSON.parse(fs.readFileSync(paths.callsFile, 'utf-8'));
    } catch {
      return [];
    }
  },

  saveMessage(username, conversationId, messageData) {
    const paths = this.getUserDir(username);
    if (!paths) return;
    try {
      const safeConvId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const convFilePath = path.join(paths.chatsDir, `${safeConvId}.json`);
      let messages = [];
      if (fs.existsSync(convFilePath)) {
        try {
          messages = JSON.parse(fs.readFileSync(convFilePath, 'utf-8'));
        } catch {
          messages = [];
        }
      }
      const existingIdx = messages.findIndex((m) => m.id === messageData.id);
      if (existingIdx !== -1) {
        messages[existingIdx] = { ...messages[existingIdx], ...messageData, updatedAt: Date.now() };
      } else {
        messages.push({ ...messageData, storedAt: Date.now() });
      }
      writeJsonFileSync(convFilePath, messages);

      // Update chats summary
      let chatsIndex = [];
      if (fs.existsSync(paths.chatsFile)) {
        try {
          chatsIndex = JSON.parse(fs.readFileSync(paths.chatsFile, 'utf-8'));
        } catch {
          chatsIndex = [];
        }
      }
      const chatIdx = chatsIndex.findIndex((c) => c.conversationId === conversationId);
      const summary = {
        conversationId,
        lastMessage: messageData,
        updatedAt: messageData.timestamp || Date.now(),
      };
      if (chatIdx !== -1) {
        chatsIndex[chatIdx] = { ...chatsIndex[chatIdx], ...summary };
      } else {
        chatsIndex.unshift(summary);
      }
      chatsIndex.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      writeJsonFileSync(paths.chatsFile, chatsIndex);
    } catch (err) {
      console.error(`[DB Error] Saving message for ${username}:`, err);
    }
  },

  updateMessage(username, conversationId, messageId, updates) {
    const paths = this.getUserDir(username);
    if (!paths) return;
    try {
      const safeConvId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const convFilePath = path.join(paths.chatsDir, `${safeConvId}.json`);
      if (!fs.existsSync(convFilePath)) return;
      let messages = JSON.parse(fs.readFileSync(convFilePath, 'utf-8'));
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx !== -1) {
        messages[idx] = { ...messages[idx], ...updates, updatedAt: Date.now() };
        writeJsonFileSync(convFilePath, messages);
      }
    } catch (err) {
      console.error(`[DB Error] Updating message for ${username}:`, err);
    }
  },

  getMessages(username, conversationId) {
    const paths = this.getUserDir(username);
    if (!paths) return [];
    const safeConvId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const convFilePath = path.join(paths.chatsDir, `${safeConvId}.json`);
    if (!fs.existsSync(convFilePath)) return [];
    try {
      return JSON.parse(fs.readFileSync(convFilePath, 'utf-8'));
    } catch {
      return [];
    }
  },

  toggleStarred(username, message) {
    const paths = this.getUserDir(username);
    if (!paths || !message || !message.id) return { starred: false };
    try {
      let starred = [];
      if (fs.existsSync(paths.starredFile)) {
        try {
          starred = JSON.parse(fs.readFileSync(paths.starredFile, 'utf-8'));
        } catch {
          starred = [];
        }
      }
      const idx = starred.findIndex((m) => m.id === message.id);
      let isStarred = false;
      if (idx !== -1) {
        starred.splice(idx, 1);
        isStarred = false;
      } else {
        starred.unshift({ ...message, starredAt: Date.now() });
        isStarred = true;
      }
      writeJsonFileSync(paths.starredFile, starred);
      return { starred: isStarred, count: starred.length };
    } catch (err) {
      console.error(`[DB Error] Toggling star for ${username}:`, err);
      return { starred: false };
    }
  },

  getStarred(username) {
    const paths = this.getUserDir(username);
    if (!paths || !fs.existsSync(paths.starredFile)) return [];
    try {
      return JSON.parse(fs.readFileSync(paths.starredFile, 'utf-8'));
    } catch {
      return [];
    }
  },
};

export const db = {
  users: new Collection('users'),
  conversations: new Collection('conversations'),
  messages: new Collection('messages'),
  calls: new Collection('calls'),
};
