import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import initSqlJs from 'sql.js';
import bcrypt from 'bcryptjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000');
const DB_PATH = join(__dirname, 'chat.db');
const UPLOADS_DIR = join(__dirname, 'uploads');
const PUBLIC_DIR = join(__dirname, 'public');

if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

// --- sql.js helpers ---
const SQL = await initSqlJs();
let db;
if (existsSync(DB_PATH)) {
  const buf = readFileSync(DB_PATH);
  db = new SQL.Database(buf);
} else {
  db = new SQL.Database();
}

function saveDb() { writeFileSync(DB_PATH, Buffer.from(db.export())); }

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function exec(sql) {
  const r = db.exec(sql);
  saveDb();
  return r;
}

function queryAll(sql, params = []) {
  let stmt; try { stmt = db.prepare(sql); stmt.bind(params); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows; } catch(e) { if (stmt) stmt.free(); throw e; }
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params); return rows.length > 0 ? rows[0] : null;
}

function insert(sql, params = []) {
  db.run(sql, params);
  const r = db.exec("SELECT last_insert_rowid() as id");
  saveDb();
  return Number(r[0].values[0][0]);
}

// --- Schema ---
exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin INTEGER DEFAULT 0, approved INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
exec(`CREATE TABLE IF NOT EXISTS providers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL, api_key TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
exec(`CREATE TABLE IF NOT EXISTS models (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER REFERENCES providers(id), model_id TEXT NOT NULL, display_name TEXT, logo_url TEXT, visible INTEGER DEFAULT 1, context_window INTEGER, max_tokens INTEGER, supports_reasoning INTEGER DEFAULT 0, supports_vision INTEGER DEFAULT 0, is_custom INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
exec(`CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id), title TEXT DEFAULT '新对话', model_id TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
exec(`CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC)`);
exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, csrf_token TEXT, expires INTEGER NOT NULL)`);
exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, model_id TEXT, content TEXT NOT NULL, reasoning TEXT, tokens_used INTEGER, created_at TEXT DEFAULT (datetime('now')))`);
exec(`CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at)`);

// Migrations
try { queryOne("SELECT model_id FROM messages LIMIT 1"); } catch(e) { exec("ALTER TABLE messages ADD COLUMN model_id TEXT"); }
try { queryOne("SELECT approved FROM users LIMIT 1"); } catch(e) { exec("ALTER TABLE users ADD COLUMN approved INTEGER DEFAULT 1"); exec("UPDATE users SET approved=1 WHERE is_admin=1"); exec("UPDATE users SET approved=0 WHERE is_admin=0"); }
try { queryOne("SELECT is_custom FROM models LIMIT 1"); } catch(e) { exec("ALTER TABLE models ADD COLUMN is_custom INTEGER DEFAULT 0"); }
try { queryOne("SELECT csrf_token FROM sessions LIMIT 1"); } catch(e) { exec("ALTER TABLE sessions ADD COLUMN csrf_token TEXT"); }

const adminCount = queryOne("SELECT COUNT(*) as c FROM users WHERE is_admin=1");
let needsSetup = (adminCount && adminCount.c === 0);

const SESSION_TTL = 24 * 60 * 60 * 1000;

function setSession(res, userId) {
  const sid = crypto.randomUUID();
  const csrfToken = crypto.randomUUID();
  const expires = Date.now() + SESSION_TTL;
  run("INSERT INTO sessions (id, user_id, csrf_token, expires) VALUES (?, ?, ?, ?)", [sid, userId, csrfToken, expires]);
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; Max-Age=${SESSION_TTL / 1000}`);
  return { sid, csrfToken };
}

function getSession(req) {
  const cookie = (req.headers.cookie || '').split(';').find(c => c.trim().startsWith('sid='));
  if (!cookie) return null;
  const sid = cookie.split('=')[1].trim();
  const now = Date.now();
  const row = queryOne("SELECT * FROM sessions WHERE id=? AND expires>?", [sid, now]);
  if (!row) { run("DELETE FROM sessions WHERE id=?", [sid]); return null; }
  return { userId: row.user_id, expires: row.expires, csrfToken: row.csrf_token };
}

function verifyCsrf(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  const token = req.headers['x-csrf-token'] || '';
  const s = getSession(req);
  return s && s.csrfToken && s.csrfToken === token;
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
  const user = queryOne("SELECT * FROM users WHERE id=?", [s.userId]);
  if (!user || !user.is_admin) { json(res, { error: 'Forbidden' }, 403); return null; }
  return user;
}

function requireApproved(req, res) {
  const s = getSession(req);
  if (!s) { json(res, { error: 'Unauthorized' }, 401); return null; }
  const user = queryOne("SELECT * FROM users WHERE id=?", [s.userId]);
  if (!user) { json(res, { error: 'Unauthorized' }, 401); return null; }
  if (!user.is_admin && !user.approved) { json(res, { error: '账号待审核，请等待管理员通过' }, 403); return null; }
  return user;
}

function getMimeType(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const types = { html: 'text/html', css: 'text/css', js: 'application/javascript', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', json: 'application/json' };
  return types[ext] || 'application/octet-stream';
}

function parseMultipart(buffer, contentType) {
  const hdrMatch = contentType.match(/boundary=([^;]+)/);
  if (!hdrMatch) return null;
  const boundary = hdrMatch[1].trim().replace(/^"|"$/g, '');
  const boundaryBytes = Buffer.from('--' + boundary);
  let idx = buffer.indexOf(boundaryBytes);
  if (idx < 0) return null;
  idx += boundaryBytes.length;
  while (idx < buffer.length) {
    while (idx < buffer.length && (buffer[idx] === 0x0d || buffer[idx] === 0x0a)) idx++;
    const hdrEnd = buffer.indexOf('\r\n\r\n', idx);
    if (hdrEnd < 0) break;
    const headerStr = buffer.slice(idx, hdrEnd).toString();
    const fnMatch = headerStr.match(/filename="([^"]+)"/);
    if (fnMatch) {
      const bodyStart = hdrEnd + 4;
      const nextBoundary = buffer.indexOf(boundaryBytes, bodyStart);
      if (nextBoundary < 0) return null;
      let bodyEnd = nextBoundary - 2;
      while (bodyEnd > bodyStart && (buffer[bodyEnd] === 0x0d || buffer[bodyEnd] === 0x0a)) bodyEnd--;
      bodyEnd++;
      return { filename: fnMatch[1], data: buffer.slice(bodyStart, bodyEnd) };
    }
    idx = buffer.indexOf(boundaryBytes, hdrEnd);
    if (idx < 0) break;
    idx += boundaryBytes.length;
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  if (method === 'GET' && (path.startsWith('/public/') || path === '/style.css')) {
    const filePath = path.startsWith('/public/') ? join(__dirname, path.slice(1)) : join(PUBLIC_DIR, path.slice(1));
    return serveStatic(res, filePath, getMimeType(filePath));
  }

  if (method === 'GET' && path.startsWith('/uploads/')) {
    const filePath = join(__dirname, path.slice(1));
    if (!filePath.startsWith(UPLOADS_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
    return serveStatic(res, filePath, getMimeType(filePath));
  }

  if (method === 'GET') {
    const pages = { '/': 'login.html', '/login': 'login.html', '/chat': 'index.html', '/admin': 'admin.html' };
    if (pages[path]) return serveStatic(res, join(PUBLIC_DIR, pages[path]), 'text/html');
    const redirects = { '/login.html': '/login', '/index.html': '/chat', '/admin.html': '/admin' };
    if (redirects[path]) { res.writeHead(301, { Location: redirects[path] }); res.end(); return; }
  }

  // CSRF validation for state-changing requests (exclude auth endpoints)
  if ((method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH') && path.startsWith('/api/') && !path.startsWith('/api/auth/')) {
    const s = getSession(req);
    if (!s) return json(res, { error: 'Unauthorized' }, 401);
    if (!verifyCsrf(req)) return json(res, { error: 'CSRF token invalid' }, 403);
  }

  // --- Auth ---
  if (method === 'GET' && path === '/api/auth/me') {
    const s = getSession(req);
    if (!s) return json(res, { error: 'Unauthorized' }, 401);
    const user = queryOne("SELECT id, email, is_admin, approved FROM users WHERE id=?", [s.userId]);
    return json(res, { user });
  }

  if (method === 'POST' && path === '/api/auth/register') {
    const { email, password } = await parseBody(req);
    if (!email || !password || password.length < 4) return json(res, { error: '邮箱和密码必填(最少4位)' }, 400);
    const existing = queryOne("SELECT id FROM users WHERE email=?", [email]);
    if (existing) return json(res, { error: '邮箱已注册' }, 409);
    const hash = bcrypt.hashSync(password, 10);
    const isAdmin = needsSetup ? 1 : 0;
    const id = insert("INSERT INTO users (email, password_hash, is_admin, approved) VALUES (?,?,?,?)", [email, hash, isAdmin, isAdmin ? 1 : 0]);
    if (isAdmin) needsSetup = false;
    const { csrfToken } = setSession(res, id);
    return json(res, { user: { id, email, is_admin: isAdmin }, csrfToken }, 201);
  }

  if (method === 'POST' && path === '/api/auth/login') {
    const { email, password } = await parseBody(req);
    const user = queryOne("SELECT * FROM users WHERE email=?", [email]);
    if (!user) return json(res, { error: '邮箱或密码错误' }, 401);
    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return json(res, { error: '邮箱或密码错误' }, 401);
    const { csrfToken } = setSession(res, user.id);
    return json(res, { user: { id: user.id, email: user.email, is_admin: user.is_admin, approved: user.approved }, csrfToken });
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    const s = getSession(req);
    if (s) run("DELETE FROM sessions WHERE user_id=?", [s.userId]);
    res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
    return json(res, { ok: true });
  }

  if (method === 'GET' && path === '/api/auth/needs-setup') {
    return json(res, { needsSetup });
  }

  // --- Admin: Providers ---
  if (method === 'GET' && path === '/api/admin/providers') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const providers = queryAll("SELECT * FROM providers");
    return json(res, providers.map(p => ({ ...p, api_key: p.api_key.slice(0, 4) + '****' + p.api_key.slice(-4) })));
  }

  if (method === 'POST' && path === '/api/admin/providers') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const { name, base_url, api_key } = await parseBody(req);
    if (!base_url || !api_key) return json(res, { error: 'Base URL 和 API Key 必填' }, 400);
    run("INSERT INTO providers (name, base_url, api_key) VALUES (?,?,?)", [name || '', base_url, api_key]);
    return json(res, { ok: true });
  }

  if (method === 'DELETE' && path.startsWith('/api/admin/providers/')) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const pid = parseInt(path.split('/').pop());
    run("DELETE FROM providers WHERE id=?", [pid]);
    run("DELETE FROM models WHERE provider_id=?", [pid]);
    return json(res, { ok: true });
  }

  if (method === 'POST' && path.match(/^\/api\/admin\/providers\/(\d+)\/fetch$/)) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const pid = parseInt(path.split('/')[4]);
    const provider = queryOne("SELECT * FROM providers WHERE id=?", [pid]);
    if (!provider) return json(res, { error: '提供商不存在' }, 404);
    try {
      const resp = await fetch(provider.base_url.replace(/\/$/, '') + '/models', {
        headers: { 'Authorization': `Bearer ${provider.api_key}`, 'Content-Type': 'application/json' }
      });
      if (!resp.ok) {
        return json(res, { error: '获取模型列表失败，请检查 API 配置' }, 502);
      }
      const data = await resp.json();
      const modelList = data.data || data;
      if (!Array.isArray(modelList)) return json(res, { error: 'API 返回格式不支持' }, 502);
      for (const m of modelList) {
        try { run("INSERT OR IGNORE INTO models (provider_id, model_id, display_name, visible) VALUES (?,?,?,1)", [pid, m.id, m.id]); } catch(e) {}
      }
      return json(res, { ok: true, count: modelList.length });
    } catch (err) {
      return json(res, { error: '请求失败，请检查网络连接和 API 配置' }, 502);
    }
  }

  // --- Admin: Models ---
  if (method === 'GET' && path === '/api/admin/models') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const models = queryAll("SELECT m.*, p.name as provider_name FROM models m LEFT JOIN providers p ON m.provider_id=p.id ORDER BY m.id");
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
    run(`UPDATE models SET ${updates.join(',')} WHERE id=?`, params);
    return json(res, { ok: true });
  }

  if (method === 'DELETE' && path.startsWith('/api/admin/models/')) {
    const admin = requireAdmin(req, res); if (!admin) return;
    run("DELETE FROM models WHERE id=?", [parseInt(path.split('/').pop())]);
    return json(res, { ok: true });
  }

  if (method === 'POST' && path.match(/^\/api\/admin\/models\/(\d+)\/logo$/)) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const mid = parseInt(path.split('/')[4]);
    const model = queryOne("SELECT * FROM models WHERE id=?", [mid]);
    if (!model) return json(res, { error: '模型不存在' }, 404);
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const buf = Buffer.concat(buffers);
    if (buf.length > 2 * 1024 * 1024) return json(res, { error: '文件大小不能超过2MB' }, 400);
    const result = parseMultipart(buf, req.headers['content-type']);
    if (!result) return json(res, { error: '未找到上传文件' }, 400);
    const ext = result.filename.split('.').pop().toLowerCase();
    if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return json(res, { error: '仅支持 PNG/JPG/WEBP' }, 400);
    const mimeMap = { png: [0x89, 0x50, 0x4E, 0x47], jpg: [0xFF, 0xD8, 0xFF], jpeg: [0xFF, 0xD8, 0xFF], webp: [0x52, 0x49, 0x46, 0x46] };
    const magic = mimeMap[ext];
    if (magic && result.data.length >= magic.length) {
      const header = Array.from(result.data.slice(0, magic.length));
      if (JSON.stringify(header) !== JSON.stringify(magic)) return json(res, { error: '文件内容与扩展名不匹配' }, 400);
    }
    const filename = `model_${mid}_${Date.now()}.${ext}`;
    writeFileSync(join(UPLOADS_DIR, filename), result.data);
    const logoUrl = `/uploads/${filename}`;
    run("UPDATE models SET logo_url=? WHERE id=?", [logoUrl, mid]);
    return json(res, { ok: true, logo_url: logoUrl });
  }

  if (method === 'POST' && path === '/api/admin/models/custom') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const { provider_id, model_id, display_name, visible, supports_reasoning } = await parseBody(req);
    if (!provider_id || !model_id) return json(res, { error: '提供商和模型ID必填' }, 400);
    const exists = queryOne("SELECT id FROM models WHERE model_id=?", [model_id]);
    if (exists) return json(res, { error: '模型ID已存在' }, 409);
    run("INSERT INTO models (provider_id, model_id, display_name, visible, supports_reasoning, is_custom) VALUES (?,?,?,?,?,1)", [provider_id, model_id, display_name || model_id, visible !== undefined ? (visible ? 1 : 0) : 1, supports_reasoning ? 1 : 0]);
    return json(res, { ok: true });
  }

  // --- Admin: Users ---
  if (method === 'GET' && path === '/api/admin/users') {
    const admin = requireAdmin(req, res); if (!admin) return;
    return json(res, queryAll("SELECT id, email, is_admin, approved, created_at FROM users ORDER BY created_at DESC"));
  }

  if (method === 'PATCH' && path.startsWith('/api/admin/users/')) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const uid = parseInt(path.split('/').pop());
    const body = await parseBody(req);
    if (body.approved !== undefined) {
      run("UPDATE users SET approved=? WHERE id=? AND is_admin=0", [body.approved ? 1 : 0, uid]);
    }
    return json(res, { ok: true });
  }

  if (method === 'DELETE' && path.startsWith('/api/admin/users/')) {
    const admin = requireAdmin(req, res); if (!admin) return;
    run("DELETE FROM users WHERE id=? AND is_admin=0", [parseInt(path.split('/').pop())]);
    return json(res, { ok: true });
  }

  // --- User: Models ---
  if (method === 'GET' && path === '/api/models') {
    const s = getSession(req);
    const user = s ? queryOne("SELECT * FROM users WHERE id=?", [s.userId]) : null;
    const models = queryAll("SELECT * FROM models ORDER BY id");
    if (user && user.is_admin) return json(res, models);
    return json(res, models.filter(m => m.visible));
  }

  // --- User: Conversations ---
  if (method === 'GET' && path === '/api/conversations') {
    const user = requireApproved(req, res); if (!user) return;
    return json(res, queryAll("SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC", [user.id]));
  }

  if (method === 'POST' && path === '/api/conversations') {
    const user = requireApproved(req, res); if (!user) return;
    const { model_id } = await parseBody(req);
    const id = insert("INSERT INTO conversations (user_id, model_id, title) VALUES (?,?,?)", [user.id, model_id, '新对话']);
    return json(res, { id, user_id: user.id, model_id, title: '新对话' }, 201);
  }

  if (method === 'PATCH' && path.startsWith('/api/conversations/')) {
    const user = requireApproved(req, res); if (!user) return;
    const cid = parseInt(path.split('/').pop());
    const { title } = await parseBody(req);
    run("UPDATE conversations SET title=?, updated_at=datetime('now') WHERE id=? AND user_id=?", [title, cid, user.id]);
    return json(res, { ok: true });
  }

  if (method === 'DELETE' && path.startsWith('/api/conversations/')) {
    const user = requireApproved(req, res); if (!user) return;
    run("DELETE FROM conversations WHERE id=? AND user_id=?", [parseInt(path.split('/').pop()), user.id]);
    return json(res, { ok: true });
  }

  if (method === 'GET' && path.match(/^\/api\/conversations\/(\d+)\/messages$/)) {
    const user = requireApproved(req, res); if (!user) return;
    const cid = parseInt(path.split('/')[3]);
    return json(res, queryAll("SELECT m.*, (SELECT md.logo_url FROM models md WHERE md.model_id=m.model_id LIMIT 1) as model_logo_url, (SELECT md.display_name FROM models md WHERE md.model_id=m.model_id LIMIT 1) as model_display_name FROM messages m WHERE m.conversation_id=? ORDER BY m.created_at", [cid]));
  }

  // --- Chat SSE ---
  if (method === 'POST' && path === '/api/chat/completions') {
    const user = requireApproved(req, res); if (!user) return;
    const body = await parseBody(req);
    const { conversation_id, model: modelId, messages } = body;

    const model = queryOne("SELECT m.*, p.base_url, p.api_key FROM models m JOIN providers p ON m.provider_id=p.id WHERE m.model_id=?", [modelId]);
    if (!model) return json(res, { error: '模型不存在' }, 404);

    const lastMsg = messages[messages.length - 1];
    if (lastMsg) {
      run("INSERT INTO messages (conversation_id, role, model_id, content) VALUES (?,?,?,?)", [conversation_id, 'user', modelId, lastMsg.content]);
      run("UPDATE conversations SET updated_at=datetime('now') WHERE id=?", [conversation_id]);
    }

    const history = queryAll("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at", [conversation_id]);
    const apiMessages = history.map(m => ({ role: m.role, content: m.content }));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    function sse(event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

    try {
      const apiResp = await fetch(model.base_url.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${model.api_key}` },
        body: JSON.stringify({ model: model.model_id, messages: apiMessages, stream: true })
      });

      if (!apiResp.ok) {
        sse('error', { message: 'AI 服务请求失败，请稍后重试' });
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
              if (reasoningActive) { sse('reasoning_done', {}); reasoningActive = false; }
              fullContent += delta.content;
              sse('content', { delta: delta.content });
            }
          } catch (e) {}
        }
      }
      if (reasoningActive) sse('reasoning_done', {});
      run("INSERT INTO messages (conversation_id, role, model_id, content, reasoning) VALUES (?,?,?,?,?)", [conversation_id, 'assistant', modelId, fullContent, fullReasoning || null]);
      sse('done', {});
    } catch (err) {
      sse('error', { message: '请求处理失败，请稍后重试' });
      sse('done', {});
    }
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

setInterval(() => {
  run("DELETE FROM sessions WHERE expires<?", [Date.now()]);
}, 300000);

server.listen(PORT, () => {
  console.log(`LiteChat running at http://localhost:${PORT}`);
});
