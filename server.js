import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000');
const DB_PATH = join(__dirname, 'chat.db');
const UPLOADS_DIR = join(__dirname, 'uploads');
const PUBLIC_DIR = join(__dirname, 'public');

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

function requireAdmin(req, res) {
  const s = getSession(req);
  if (!s) { json(res, { error: 'Unauthorized' }, 401); return null; }
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(s.userId);
  if (!user || !user.is_admin) { json(res, { error: 'Forbidden' }, 403); return null; }
  return user;
}

function getMimeType(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const types = { html: 'text/html', css: 'text/css', js: 'application/javascript', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', json: 'application/json' };
  return types[ext] || 'application/octet-stream';
}

function parseMultipart(buffer) {
  const str = buffer.toString();
  const boundaryMatch = str.match(/boundary=([^\r\n]+)/);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1].trim();
  const parts = str.split('--' + boundary);
  for (const part of parts) {
    if (!part.includes('filename="')) continue;
    const filenameMatch = part.match(/filename="([^"]+)"/);
    if (!filenameMatch) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    let bodyStart = headerEnd + 4;
    let body = buffer.slice(bodyStart);
    let dataEnd = body.length - 4;
    while (dataEnd > 0) {
      if (body[dataEnd] === 0x2d && body[dataEnd + 1] === 0x2d) { dataEnd -= 2; break; }
      dataEnd--;
    }
    const fileData = body.slice(0, dataEnd);
    return { filename: filenameMatch[1], data: fileData };
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // --- Static files ---
  if (method === 'GET' && (path.startsWith('/public/') || path === '/style.css')) {
    const filePath = path.startsWith('/public/') ? join(__dirname, path.slice(1)) : join(PUBLIC_DIR, path.slice(1));
    return serveStatic(res, filePath, getMimeType(filePath));
  }

  if (method === 'GET' && path.startsWith('/uploads/')) {
    const filePath = join(__dirname, path.slice(1));
    if (!filePath.startsWith(UPLOADS_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
    return serveStatic(res, filePath, getMimeType(filePath));
  }

  // --- Pages ---
  if (method === 'GET') {
    const pages = { '/': 'login.html', '/login.html': 'login.html', '/index.html': 'index.html', '/admin.html': 'admin.html' };
    if (pages[path]) return serveStatic(res, join(PUBLIC_DIR, pages[path]), 'text/html');
  }

  // --- Auth ---
  if (method === 'GET' && path === '/api/auth/me') {
    const s = getSession(req);
    if (!s) return json(res, { error: 'Unauthorized' }, 401);
    const user = db.prepare('SELECT id, email, is_admin FROM users WHERE id=?').get(s.userId);
    return json(res, { user });
  }

  if (method === 'POST' && path === '/api/auth/register') {
    const { email, password } = await parseBody(req);
    if (!email || !password || password.length < 4) return json(res, { error: '邮箱和密码必填(最少4位)' }, 400);
    const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (existing) return json(res, { error: '邮箱已注册' }, 409);
    const hash = await bcrypt.hash(password, 10);
    const isAdmin = needsSetup ? 1 : 0;
    const r = db.prepare('INSERT INTO users (email, password_hash, is_admin) VALUES (?,?,?)').run(email, hash, isAdmin);
    if (isAdmin) needsSetup = false;
    setSession(res, Number(r.lastInsertRowid));
    return json(res, { user: { id: r.lastInsertRowid, email, is_admin: isAdmin } }, 201);
  }

  if (method === 'POST' && path === '/api/auth/login') {
    const { email, password } = await parseBody(req);
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user) return json(res, { error: '邮箱或密码错误' }, 401);
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return json(res, { error: '邮箱或密码错误' }, 401);
    setSession(res, user.id);
    return json(res, { user: { id: user.id, email: user.email, is_admin: user.is_admin } });
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return json(res, { ok: true });
  }

  if (method === 'GET' && path === '/api/auth/needs-setup') {
    return json(res, { needsSetup });
  }

  // --- Admin: Providers ---
  if (method === 'GET' && path === '/api/admin/providers') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const providers = db.prepare('SELECT * FROM providers').all();
    return json(res, providers.map(p => ({ ...p, api_key: p.api_key.slice(0, 4) + '****' + p.api_key.slice(-4) })));
  }

  if (method === 'POST' && path === '/api/admin/providers') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const { name, base_url, api_key } = await parseBody(req);
    if (!base_url || !api_key) return json(res, { error: 'Base URL 和 API Key 必填' }, 400);
    const existing = db.prepare('SELECT id FROM providers').all();
    if (existing.length > 0) {
      db.prepare('UPDATE providers SET name=?, base_url=?, api_key=? WHERE id=?').run(name || '', base_url, api_key, existing[0].id);
    } else {
      db.prepare('INSERT INTO providers (name, base_url, api_key) VALUES (?,?,?)').run(name || '', base_url, api_key);
    }
    return json(res, { ok: true });
  }

  if (method === 'DELETE' && path.startsWith('/api/admin/providers/')) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const pid = parseInt(path.split('/').pop());
    db.prepare('DELETE FROM providers WHERE id=?').run(pid);
    db.prepare('DELETE FROM models WHERE provider_id=?').run(pid);
    return json(res, { ok: true });
  }

  if (method === 'POST' && path.match(/^\/api\/admin\/providers\/(\d+)\/fetch$/)) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const pid = parseInt(path.split('/')[4]);
    const provider = db.prepare('SELECT * FROM providers WHERE id=?').get(pid);
    if (!provider) return json(res, { error: '提供商不存在' }, 404);
    try {
      const resp = await fetch(provider.base_url.replace(/\/$/, '') + '/models', {
        headers: { 'Authorization': `Bearer ${provider.api_key}`, 'Content-Type': 'application/json' }
      });
      if (!resp.ok) {
        const et = await resp.text().catch(() => '');
        return json(res, { error: `API 返回 ${resp.status}: ${et.slice(0, 200)}` }, 502);
      }
      const data = await resp.json();
      const modelList = data.data || data;
      if (!Array.isArray(modelList)) return json(res, { error: 'API 返回格式不支持' }, 502);
      const insert = db.prepare('INSERT OR IGNORE INTO models (provider_id, model_id, display_name, visible) VALUES (?,?,?,1)');
      const tx = db.transaction((items) => { for (const m of items) insert.run(pid, m.id, m.id); });
      tx(modelList);
      return json(res, { ok: true, count: modelList.length });
    } catch (err) {
      return json(res, { error: `请求失败: ${err.message}` }, 502);
    }
  }

  // --- Admin: Models ---
  if (method === 'GET' && path === '/api/admin/models') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const models = db.prepare(`
      SELECT m.*, p.name as provider_name FROM models m
      LEFT JOIN providers p ON m.provider_id=p.id ORDER BY m.id
    `).all();
    return json(res, models);
  }

  if (method === 'PATCH' && path.startsWith('/api/admin/models/')) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const mid = parseInt(path.split('/').pop());
    const body = await parseBody(req);
    const updates = []; const params = [];
    if (body.display_name !== undefined) { updates.push('display_name=?'); params.push(body.display_name); }
    if (body.visible !== undefined) { updates.push('visible=?'); params.push(body.visible ? 1 : 0); }
    if (body.supports_reasoning !== undefined) { updates.push('supports_reasoning=?'); params.push(body.supports_reasoning ? 1 : 0); }
    if (body.supports_vision !== undefined) { updates.push('supports_vision=?'); params.push(body.supports_vision ? 1 : 0); }
    if (updates.length === 0) return json(res, { error: '无更新字段' }, 400);
    params.push(mid);
    db.prepare(`UPDATE models SET ${updates.join(',')} WHERE id=?`).run(...params);
    return json(res, { ok: true });
  }

  if (method === 'POST' && path.match(/^\/api\/admin\/models\/(\d+)\/logo$/)) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const mid = parseInt(path.split('/')[4]);
    const model = db.prepare('SELECT * FROM models WHERE id=?').get(mid);
    if (!model) return json(res, { error: '模型不存在' }, 404);
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const buf = Buffer.concat(buffers);
    const result = parseMultipart(buf);
    if (!result) return json(res, { error: '未找到上传文件' }, 400);
    const ext = result.filename.split('.').pop().toLowerCase();
    if (!['png', 'jpg', 'jpeg', 'svg', 'webp'].includes(ext)) return json(res, { error: '仅支持 PNG/JPG/SVG/WEBP' }, 400);
    const filename = `model_${mid}_${Date.now()}.${ext}`;
    const filepath = join(UPLOADS_DIR, filename);
    writeFileSync(filepath, result.data);
    const logoUrl = `/uploads/${filename}`;
    db.prepare('UPDATE models SET logo_url=? WHERE id=?').run(logoUrl, mid);
    return json(res, { ok: true, logo_url: logoUrl });
  }

  // --- User: Models ---
  if (method === 'GET' && path === '/api/models') {
    const s = getSession(req);
    const user = s ? db.prepare('SELECT * FROM users WHERE id=?').get(s.userId) : null;
    const models = db.prepare('SELECT * FROM models ORDER BY id').all();
    if (user && user.is_admin) return json(res, models);
    return json(res, models.filter(m => m.visible));
  }

  // --- User: Conversations ---
  if (method === 'GET' && path === '/api/conversations') {
    const s = getSession(req); if (!s) return json(res, { error: 'Unauthorized' }, 401);
    const convs = db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC').all(s.userId);
    return json(res, convs);
  }

  if (method === 'POST' && path === '/api/conversations') {
    const s = getSession(req); if (!s) return json(res, { error: 'Unauthorized' }, 401);
    const { model_id } = await parseBody(req);
    const r = db.prepare('INSERT INTO conversations (user_id, model_id, title) VALUES (?,?,?)').run(s.userId, model_id, '新对话');
    return json(res, { id: Number(r.lastInsertRowid), user_id: s.userId, model_id, title: '新对话' }, 201);
  }

  if (method === 'PATCH' && path.startsWith('/api/conversations/')) {
    const s = getSession(req); if (!s) return json(res, { error: 'Unauthorized' }, 401);
    const cid = parseInt(path.split('/').pop());
    const { title } = await parseBody(req);
    db.prepare('UPDATE conversations SET title=?, updated_at=datetime("now") WHERE id=? AND user_id=?').run(title, cid, s.userId);
    return json(res, { ok: true });
  }

  if (method === 'DELETE' && path.startsWith('/api/conversations/')) {
    const s = getSession(req); if (!s) return json(res, { error: 'Unauthorized' }, 401);
    const cid = parseInt(path.split('/').pop());
    db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(cid, s.userId);
    return json(res, { ok: true });
  }

  if (method === 'GET' && path.match(/^\/api\/conversations\/(\d+)\/messages$/)) {
    const s = getSession(req); if (!s) return json(res, { error: 'Unauthorized' }, 401);
    const cid = parseInt(path.split('/')[3]);
    const messages = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at').all(cid);
    return json(res, messages);
  }

  // --- Chat SSE ---
  if (method === 'POST' && path === '/api/chat/completions') {
    const s = getSession(req); if (!s) return json(res, { error: 'Unauthorized' }, 401);
    const body = await parseBody(req);
    const { conversation_id, model: modelId, messages } = body;

    const model = db.prepare('SELECT m.*, p.base_url, p.api_key FROM models m JOIN providers p ON m.provider_id=p.id WHERE m.model_id=?').get(modelId);
    if (!model) return json(res, { error: '模型不存在' }, 404);

    // Save user message
    const lastMsg = messages[messages.length - 1];
    if (lastMsg) {
      db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)').run(conversation_id, 'user', lastMsg.content);
      db.prepare('UPDATE conversations SET updated_at=datetime("now") WHERE id=?').run(conversation_id);
    }

    // Build conversation history
    const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at').all(conversation_id);
    const apiMessages = history.map(m => ({ role: m.role, content: m.content }));

    // SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    function sse(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    try {
      const apiResp = await fetch(model.base_url.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${model.api_key}` },
        body: JSON.stringify({ model: model.model_id, messages: apiMessages, stream: true })
      });

      if (!apiResp.ok) {
        const et = await apiResp.text().catch(() => '');
        sse('error', { message: `API ${apiResp.status}: ${et.slice(0, 500)}` });
        sse('done', {});
        return res.end();
      }

      const reader = apiResp.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let fullReasoning = '';
      let reasoningActive = false;
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.reasoning_content) {
              fullReasoning += delta.reasoning_content;
              sse('reasoning', { delta: delta.reasoning_content });
              reasoningActive = true;
            }
            if (delta.content) {
              if (reasoningActive) {
                sse('reasoning_done', {});
                reasoningActive = false;
              }
              fullContent += delta.content;
              sse('content', { delta: delta.content });
            }
          } catch (e) {}
        }
      }

      if (reasoningActive) sse('reasoning_done', {});

      // Save assistant message
      db.prepare('INSERT INTO messages (conversation_id, role, content, reasoning) VALUES (?,?,?,?)').run(
        conversation_id, 'assistant', fullContent, fullReasoning || null
      );

      sse('done', {});
    } catch (err) {
      sse('error', { message: err.message });
      sse('done', {});
    }
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// Session cleanup
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (s.expires < now) sessions.delete(sid);
  }
}, 300000);

server.listen(PORT, () => {
  console.log(`LiteChat running at http://localhost:${PORT}`);
});
