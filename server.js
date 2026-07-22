import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000');
const DB_PATH = join(__dirname, 'chat.db');
const UPLOADS_DIR = join(__dirname, 'uploads');

if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id INTEGER REFERENCES providers(id),
    model_id TEXT NOT NULL,
    display_name TEXT,
    logo_url TEXT,
    visible INTEGER DEFAULT 1,
    context_window INTEGER,
    max_tokens INTEGER,
    supports_reasoning INTEGER DEFAULT 0,
    supports_vision INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    title TEXT DEFAULT '新对话',
    model_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT,
    tokens_used INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
`);

const adminCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin=1').get();
let needsSetup = adminCount.c === 0;

const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000;

function setSession(res, userId) {
  const sid = crypto.randomUUID();
  sessions.set(sid, { userId, expires: Date.now() + SESSION_TTL });
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`);
  return sid;
}

function getSession(req) {
  const cookie = (req.headers.cookie || '').split(';').find(c => c.trim().startsWith('sid='));
  if (!cookie) return null;
  const sid = cookie.split('=')[1].trim();
  const s = sessions.get(sid);
  if (!s || s.expires < Date.now()) { sessions.delete(sid); return null; }
  return s;
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

function serveStatic(res, filePath, contentType) {
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  if (method === 'GET' && path.startsWith('/public/')) {
    const file = path.slice(1);
    const ext = file.split('.').pop();
    const types = { html: 'text/html', css: 'text/css', js: 'application/javascript', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', ico: 'image/x-icon' };
    return serveStatic(res, join(__dirname, file), types[ext] || 'application/octet-stream');
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`LiteChat running at http://localhost:${PORT}`);
});
