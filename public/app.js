// === State ===
var currentUser = null;
var currentModel = null;
var currentConvId = null;
var models = [];
var conversations = [];
var messageModels = {};
var autoScroll = true;
var isStreaming = false;
var streamingConvId = null;
var streamingBuf = '';      // buffered content while streaming
var streamingReasoning = ''; // buffered reasoning
var highlightLoaded = false;
var userMessages = [];
var convCache = {};         // { convId: { html, scrollTop, userMessages } }
var streamReaders = {};     // { convId: reader } to potentially abort

// === DOM ===
function $s(s) { return document.querySelector(s); }

// === Theme ===
(function() {
  var t = localStorage.getItem('litechat-theme') || 'light';
  document.documentElement.setAttribute('data-theme', t);
})();

$s('#themeToggle').addEventListener('click', function() {
  var cur = document.documentElement.getAttribute('data-theme');
  var next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('litechat-theme', next);
});

// === Auth ===
async function init() {
  try {
    var res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/login'; return; }
    var data = await res.json();
    currentUser = data.user;
    $s('#userEmail').textContent = currentUser.email;
    $s('#userAvatar').textContent = (currentUser.email || 'U')[0].toUpperCase();
    if (currentUser.is_admin) $s('#adminLink').style.display = '';
    if (!currentUser.is_admin && !currentUser.approved) {
      $s('#chatMessages').innerHTML = '<div class="empty-state"><img src="/public/logo.svg" width="52" height="52" alt="LiteChat" style="opacity:0.85;"><h3>等待审核</h3><p>您的账号正在等待管理员审核，通过后即可使用</p></div>';
      $s('#msgInput').disabled = true; $s('#sendBtn').disabled = true; $s('#newChatBtn').disabled = true;
      return;
    }
    await loadModels();
    await loadConversations();
    setupAutoScroll();
    setupScrollAnchors();
  } catch(e) { window.location.href = '/login'; }
}

$s('#logoutBtn').addEventListener('click', async function() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

// === Models ===
async function loadModels() {
  try {
    var res = await fetch('/api/models');
    models = await res.json();
    var visible = models.filter(function(m) { return m.visible; });
    if (visible.length > 0) selectModel(visible[0]);
    else $s('#modelSelectName').textContent = '无可用模型';
    renderModelDropdown();
  } catch(e) {}
}

function renderModelDropdown() {
  var visible = models.filter(function(m) { return m.visible; });
  var dd = $s('#modelDropdown');
  if (visible.length === 0) { dd.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text-muted);">暂无可用模型</div>'; return; }
  var html = '', colors = ['#10a37f','#6366f1','#f59e0b','#ec4899','#8b5cf6','#06b6d4','#f97316'];
  for (var i = 0; i < visible.length; i++) {
    var m = visible[i];
    var logo = m.logo_url ? '<img src="' + m.logo_url + '" width="20" height="20" style="border-radius:5px;object-fit:cover;">' : '<div class="model-logo-placeholder" style="background:' + colors[i % colors.length] + ';">' + he((m.display_name || m.model_id).slice(0,2).toUpperCase()) + '</div>';
    var sel = currentModel && currentModel.model_id === m.model_id ? ' selected' : '';
    html += '<div class="model-dropdown-item' + sel + '" onclick="selectModelById(\'' + he_esc(m.model_id) + '\')">' + logo + '<span>' + he(m.display_name || m.model_id) + '</span></div>';
  }
  dd.innerHTML = html;
}

function selectModel(m) {
  currentModel = m;
  $s('#modelSelectName').textContent = m.display_name || m.model_id;
  var logo = $s('#modelSelectLogo');
  if (m.logo_url) { logo.src = m.logo_url; logo.style.display = ''; } else { logo.style.display = 'none'; }
  $s('#modelDropdown').style.display = 'none';
}

function selectModelById(id) {
  var m = models.find(function(x) { return x.model_id === id; });
  if (m) selectModel(m);
}

$s('#modelSelectBtn').addEventListener('click', function(e) { e.stopPropagation(); var dd = $s('#modelDropdown'); dd.style.display = dd.style.display === 'none' ? 'block' : 'none'; });
document.addEventListener('click', function() { $s('#modelDropdown').style.display = 'none'; });

// === Conversations ===
async function loadConversations() {
  try { var res = await fetch('/api/conversations'); conversations = await res.json(); renderConvList(); } catch(e) {}
}

function renderConvList() {
  var html = '';
  for (var i = 0; i < conversations.length; i++) {
    var c = conversations[i];
    var active = c.id === currentConvId ? ' active' : '';
    var streaming = c.id === streamingConvId ? ' <span style="color:var(--success);font-size:9px;">输出中</span>' : '';
    html += '<div class="conv-item' + active + '" onclick="openConversation(' + c.id + ')">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
      '<span class="conv-title">' + he(c.title || '新对话') + '</span>' + streaming +
      '<span class="conv-delete" onclick="event.stopPropagation();deleteConv(' + c.id + ')">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>' +
      '</span></div>';
  }
  $s('#convList').innerHTML = html;
}

async function newConversation() {
  if (!currentModel) return;
  var res = await fetch('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_id: currentModel.model_id }) });
  var conv = await res.json();
  conversations.unshift(conv);
  messageModels = {}; userMessages = [];
  currentConvId = conv.id;
  $s('#chatMessages').innerHTML = '<div class="empty-state"><img src="/public/logo.svg" width="52" height="52" alt="LiteChat" style="opacity:0.85;"><h3>新对话</h3><p>在下方输入消息开始</p></div>';
  convCache[conv.id] = { html: '', userMsgs: [], scrollTop: 0 };
  renderConvList(); updateAnchors(); scrollToBottom(true);
}

$s('#newChatBtn').addEventListener('click', newConversation);

// save current conversation state
function saveCurrent() {
  if (!currentConvId) return;
  var msgs = $s('#chatMessages');
  var ums = [];
  var rows = msgs.querySelectorAll('.msg-row.user');
  for (var i = 0; i < rows.length; i++) {
    var b = rows[i].querySelector('.msg-bubble');
    if (b) ums.push(b.textContent || '');
  }
  convCache[currentConvId] = { html: msgs.innerHTML, userMsgs: ums, scrollTop: msgs.scrollTop };
}

async function openConversation(id) {
  if (id === currentConvId) return;
  saveCurrent();
  currentConvId = id;
  messageModels = {}; userMessages = [];
  renderConvList();

  var cache = convCache[id];
  if (cache && cache.html !== undefined) {
    $s('#chatMessages').innerHTML = cache.html;
    userMessages = (cache.userMsgs || []).map(function(c) { return { content: c }; });
    $s('#chatMessages').scrollTop = cache.scrollTop || 0;
    if (id === streamingConvId) {
      // Don't add duplicate spinner
      if (!$s('#chatMessages').querySelector('.streaming-indicator')) {
        $s('#chatMessages').insertAdjacentHTML('beforeend',
          '<div class="streaming-indicator" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:14px;font-size:12px;color:var(--text-muted);"><span class="spinner" style="width:12px;height:12px;"></span> AI 回复中...</div>'
        );
      }
    }
    updateAnchors();
    return;
  }

  // Load from DB
  try {
    var res = await fetch('/api/conversations/' + id + '/messages');
    var messages = await res.json();
    $s('#chatMessages').innerHTML = '';
    userMessages = [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.model_logo_url || m.model_display_name) messageModels['m' + i] = { logo_url: m.model_logo_url, display_name: m.model_display_name };
      appendMessage(m.role, m.content, m.reasoning, m.model_logo_url);
    }
    saveCurrent();
  } catch(e) { $s('#chatMessages').innerHTML = ''; }
  updateAnchors(); scrollToBottom(true);
}

async function deleteConv(id) {
  await fetch('/api/conversations/' + id, { method: 'DELETE' });
  conversations = conversations.filter(function(c) { return c.id !== id; });
  delete convCache[id];
  if (currentConvId === id) {
    currentConvId = null; messageModels = {}; userMessages = [];
    $s('#chatMessages').innerHTML = '<div class="empty-state"><img src="/public/logo.svg" width="52" height="52" alt="LiteChat" style="opacity:0.85;"><h3>开始对话</h3><p>选择模型后开始</p></div>';
    updateAnchors();
  }
  renderConvList();
}

// === Send Message ===
async function sendMessage() {
  var input = $s('#msgInput');
  var content = input.value.trim();
  if (!content || !currentModel) return;
  if (!currentConvId) { await newConversation(); }
  if (!currentConvId) return;

  var thisConvId = currentConvId;
  input.value = ''; autoResize();
  isStreaming = true; streamingConvId = thisConvId; streamingBuf = ''; streamingReasoning = '';
  $s('#sendBtn').disabled = true;
  renderConvList();

  var msgs = $s('#chatMessages');
  if (msgs.querySelector('.empty-state')) msgs.innerHTML = '';

  var uId = 'u' + Date.now();
  msgs.insertAdjacentHTML('beforeend',
    '<div class="msg-row user" id="' + uId + '"><div class="msg-bubble user">' + he(content) + '</div></div>'
  );
  userMessages.push({ content: content });
  scrollToBottom(true); updateAnchors();

  var aId = 'a' + Date.now();
  var modelLogo = currentModel.logo_url || '';
  var logoHtml = modelLogo
    ? '<div class="msg-avatar-model"><img src="' + modelLogo + '" alt=""></div>'
    : '<div class="msg-avatar">AI</div>';

  msgs.insertAdjacentHTML('beforeend',
    '<div class="msg-row assistant" id="' + aId + '">' + logoHtml + '<div class="msg-body" id="' + aId + '-body"></div></div>'
  );

  // Show waiting indicator
  var bodyEl = document.getElementById(aId + '-body');
  if (bodyEl) {
    bodyEl.innerHTML = '<div class="waiting-indicator" id="' + aId + '-wait" style="display:flex;align-items:center;gap:8px;padding:8px 0;font-size:12px;color:var(--text-muted);">' +
      '<span class="waiting-dots" style="display:inline-flex;gap:3px;"><span style="width:5px;height:5px;border-radius:50%;background:var(--text-muted);animation:waitBounce 1.2s infinite;"></span><span style="width:5px;height:5px;border-radius:50%;background:var(--text-muted);animation:waitBounce 1.2s .2s infinite;"></span><span style="width:5px;height:5px;border-radius:50%;background:var(--text-muted);animation:waitBounce 1.2s .4s infinite;"></span></span>' +
      '<span>等待 API 响应中...</span></div>';
  }

  try {
    var all = msgs.querySelectorAll('.msg-row.user');
    var history = [];
    for (var i = 0; i < all.length; i++) {
      var b = all[i].querySelector('.msg-bubble');
      if (b) history.push({ role: 'user', content: b.textContent });
    }

    var res = await fetch('/api/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: thisConvId, model: currentModel.model_id, messages: history })
    });

    // Remove waiting indicator
    var waitEl = document.getElementById(aId + '-wait');
    if (waitEl) waitEl.remove();

    if (!res.ok) {
      var ed = await res.json().catch(function() { return { error: '服务器返回错误' }; });
      var be = document.getElementById(aId + '-body');
      if (be) be.innerHTML = '<div class="msg-error-bubble">' + he(ed.error || ed.message || '请求失败') + '</div>';
      return;
    }

    var reader = res.body.getReader();
    streamReaders[thisConvId] = reader;
    var decoder = new TextDecoder();
    var reasoning = '', fullContent = '', collapsReasoning = false;

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      var text = decoder.decode(chunk.value, { stream: true });
      var lines = text.split('\n'), evt = '';
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.startsWith('event:')) { evt = line.slice(6).trim(); }
        else if (line.startsWith('data:') && evt) {
          try {
            var p = JSON.parse(line.slice(5));
            if (evt === 'reasoning') { reasoning += p.delta; }
            else if (evt === 'reasoning_done') { collapsReasoning = true; }
            else if (evt === 'content') { fullContent += p.delta; }
            else if (evt === 'done') {
              if (fullContent) updateConvTitle(thisConvId, fullContent.replace(/\n/g, ' ').slice(0, 30).trim());
            } else if (evt === 'error') {
              renderStreamed(thisConvId, aId, p.message || '未知错误', 'error');
              return;
            }
          } catch(e) {}
          evt = '';
        }
      }
      if (currentConvId === thisConvId) {
        renderStreamed(thisConvId, aId, fullContent, reasoning && !collapsReasoning ? reasoning : (collapsReasoning ? 'collapse' : null));
        scrollToBottom(false);
      }
    }
    if (currentConvId === thisConvId) {
      renderStreamed(thisConvId, aId, fullContent, reasoning ? 'done' : null);
    }
  } catch(err) {
    if (currentConvId === thisConvId) {
      $s('#chatMessages').insertAdjacentHTML('beforeend', '<div class="msg-error-bubble">' + he(err.message || err.toString()) + '</div>');
    }
  } finally {
    isStreaming = false; streamingConvId = null; streamingBuf = ''; streamingReasoning = '';
    delete streamReaders[thisConvId];
    if (currentConvId !== thisConvId) {
      // We were streaming in background, user switched away. Invalidate cache so
      // when they switch back, we reload from DB (which now has the full content).
      delete convCache[thisConvId];
    }
    $s('#sendBtn').disabled = false;
    $s('#msgInput').focus();
    renderConvList();
    saveCurrent();
  }
}

function renderStreamed(convId, aId, content, reasoning) {
  if (currentConvId !== convId) return;
  var body = document.getElementById(aId + '-body');
  if (!body) return;

  var ind = $s('#chatMessages').querySelector('.streaming-indicator');
  if (ind) ind.remove();

  // reasoning: string = streaming text, 'collapse' = collapse to done, 'done' = final, 'error' = show error
  var thinkStream = document.getElementById(aId + '-think');
  var thinkDone = document.getElementById(aId + '-think-done');

  if (typeof reasoning === 'string' && reasoning !== 'collapse' && reasoning !== 'done') {
    // Streaming reasoning: create or update, save raw text
    if (!thinkStream && !thinkDone) {
      body.insertAdjacentHTML('afterbegin',
        '<div class="think-streaming" id="' + aId + '-think" data-raw="' + he_attr(reasoning) + '"><div class="think-bar"></div>' +
        '<div style="flex:1;"><div style="font-size:12px;color:var(--text-secondary);margin-bottom:3px;">正在思考 <span class="think-dots"><span></span><span></span><span></span></span></div>' +
        '<div class="think-content"></div></div></div>'
      );
    } else if (thinkStream) {
      thinkStream.setAttribute('data-raw', reasoning);
    }
    var tc = document.getElementById(aId + '-think-content') || (thinkStream ? thinkStream.querySelector('.think-content') : null);
    if (tc) tc.innerHTML = renderMd(reasoning);
  }

  if ((reasoning === 'collapse' || reasoning === 'done') && thinkStream && !thinkDone) {
    // Collapse reasoning: use raw text from data-raw attribute
    var savedR = thinkStream.getAttribute('data-raw') || '';
    thinkStream.style.animation = 'thinkCollapse .35s ease-in forwards';
    setTimeout(function() {
      var ts = document.getElementById(aId + '-think');
      if (ts) ts.remove();
    }, 350);
    if (savedR) {
      body.insertAdjacentHTML('afterbegin',
        '<div class="think-collapsed" id="' + aId + '-think-done" data-reasoning="' + he_attr(savedR) + '" onclick="toggleThink(\'' + aId + '\')">' +
        '<div class="think-bar"></div><span>已深度思考</span>' +
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform:rotate(180deg);"><path d="m18 15-6-6-6 6"/></svg></div>'
      );
    }
  }

  // Content
  if (content) {
    var contentEl = document.getElementById(aId + '-content');
    if (!contentEl) {
      body.insertAdjacentHTML('beforeend', '<div class="msg-content" id="' + aId + '-content"></div>');
      contentEl = document.getElementById(aId + '-content');
    }
    if (contentEl) {
      if (reasoning === 'error') {
        contentEl.innerHTML = '<div class="msg-error-bubble">' + he(content) + '</div>';
      } else {
        contentEl.innerHTML = renderMd(content);
        if (highlightLoaded && contentEl.querySelector('pre code')) {
          var codes = contentEl.querySelectorAll('pre code');
          for (var ci = 0; ci < codes.length; ci++) { if (window.hljs) hljs.highlightElement(codes[ci]); }
        }
        bindCodeButtons(aId);
      }
    }
  }
}

// === Append static message (for loading from DB) ===
function appendMessage(role, content, reasoning, modelLogoUrl) {
  var msgs = $s('#chatMessages');
  if (msgs.querySelector('.empty-state')) msgs.innerHTML = '';
  var id = 'm' + Date.now() + Math.random().toString(36).slice(2,6);
  if (role === 'user') {
    msgs.insertAdjacentHTML('beforeend', '<div class="msg-row user" id="' + id + '"><div class="msg-bubble user">' + he(content) + '</div></div>');
    userMessages.push({ content: content });
  } else {
    var logoHtml = modelLogoUrl ? '<div class="msg-avatar-model"><img src="' + modelLogoUrl + '" alt=""></div>' : '<div class="msg-avatar">AI</div>';
    var thinkHtml = '';
    if (reasoning) {
      thinkHtml = '<div class="think-collapsed" id="' + id + '-think-done" data-reasoning="' + he_attr(reasoning) + '" onclick="toggleThink(\'' + id + '\')">' +
        '<div class="think-bar"></div><span>已深度思考</span>' +
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform:rotate(180deg);"><path d="m18 15-6-6-6 6"/></svg></div>';
    }
    msgs.insertAdjacentHTML('beforeend',
      '<div class="msg-row assistant" id="' + id + '">' + logoHtml +
      '<div class="msg-body">' + thinkHtml + '<div class="msg-content">' + renderMd(content) + '</div></div></div>'
    );
    bindCodeButtons(id);
  }
  if (highlightLoaded) {
    var codes = msgs.querySelectorAll('#' + id + ' pre code');
    for (var ci = 0; ci < codes.length; ci++) { if (window.hljs) hljs.highlightElement(codes[ci]); }
  }
}

// === Bind code buttons ===
function bindCodeButtons(rowId) {
  var row = document.getElementById(rowId);
  if (!row) return;
  var pres = row.querySelectorAll('pre');
  for (var i = 0; i < pres.length; i++) {
    var pre = pres[i]; if (pre.querySelector('.code-toolbar')) continue;
    var code = pre.querySelector('code'); if (!code) continue;
    var lang = (code.className.match(/language-(\w+)/) || [])[1] || '';
    var tb = document.createElement('div');
    tb.className = 'code-toolbar';
    tb.innerHTML = '<button class="code-btn" onclick="copyCodeBtn(this)">复制</button>' + (lang === 'html' ? '<button class="code-btn run-html" onclick="runHtml(this)">运行</button>' : '');
    pre.appendChild(tb);
  }
}

window.copyCodeBtn = function(btn) {
  var pre = btn.parentElement; while (pre && pre.tagName !== 'PRE') pre = pre.parentElement;
  if (!pre) return; var code = pre.querySelector('code'); if (!code) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code.textContent).then(function() { btn.textContent = '已复制'; setTimeout(function() { btn.textContent = '复制'; }, 1500); });
  } else {
    var ta = document.createElement('textarea'); ta.value = code.textContent; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    btn.textContent = '已复制'; setTimeout(function() { btn.textContent = '复制'; }, 1500);
  }
};

window.runHtml = function(btn) {
  var pre = btn.parentElement; while (pre && pre.tagName !== 'PRE') pre = pre.parentElement;
  if (!pre) return; var code = pre.querySelector('code'); if (!code) return;
  var body = pre.parentElement; while (body && !(body.classList && (body.classList.contains('msg-content') || body.classList.contains('msg-body')))) body = body.parentElement;
  if (!body) return;
  var existing = body.querySelector('.html-preview-wrap');
  if (existing) { existing.remove(); btn.textContent = '运行'; return; }
  btn.textContent = '收起';
  var wrap = document.createElement('div'); wrap.className = 'html-preview-wrap';
  var iframe = document.createElement('iframe'); iframe.sandbox = 'allow-scripts allow-same-origin'; iframe.srcdoc = code.textContent;
  wrap.appendChild(iframe); pre.after(wrap);
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

function toggleThink(aId) {
  var collapsed = document.getElementById(aId + '-think-done');
  var expanded = document.getElementById(aId + '-think-expanded');
  if (!collapsed && !expanded) { return; }
  if (expanded) {
    expanded.style.animation = 'thinkCollapse .3s ease-in forwards';
    setTimeout(function() { var e = document.getElementById(aId + '-think-expanded'); if (e) e.remove(); if (collapsed) collapsed.style.display = ''; }, 300);
    return;
  }
  if (!collapsed) return;
  var reasoning = collapsed.getAttribute('data-reasoning') || '';
  collapsed.style.display = 'none';
  var html = '<div class="think-expanded" id="' + aId + '-think-expanded"><div class="think-bar"></div><div style="flex:1;">' +
    '<div class="think-header" onclick="toggleThink(\'' + aId + '\')"><span>已深度思考</span>' +
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 15-6-6-6 6"/></svg></div>' +
    '<div class="think-content">' + renderMd(reasoning) + '</div></div></div>';
  collapsed.insertAdjacentHTML('afterend', html);
}

async function updateConvTitle(convId, title) {
  var c = conversations.find(function(x) { return x.id === convId; });
  if (c) { c.title = title; renderConvList(); }
  try { await fetch('/api/conversations/' + convId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title }) }); } catch(e) {}
}

// === Helpers ===
function he(s) { var d = document.createElement('div'); d.textContent = (s || ''); return d.innerHTML; }
function he_esc(s) { return (s || '').replace(/'/g, "\\'").replace(/\\/g, '\\\\'); }
function he_attr(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function renderMd(text) {
  if (!text) return '';
  var blocks = [], fenceBuf = [], inFence = false, fenceLang = '';
  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i], m = line.match(/^```(\w*)$/);
    if (m && !inFence) { if (fenceBuf.length) { blocks.push({ type: 'p', text: fenceBuf.join('\n') }); fenceBuf = []; } inFence = true; fenceLang = m[1]; continue; }
    if (line === '```' && inFence) { blocks.push({ type: 'code', lang: fenceLang, text: fenceBuf.join('\n') }); fenceBuf = []; inFence = false; fenceLang = ''; continue; }
    fenceBuf.push(line);
  }
  if (fenceBuf.length) blocks.push({ type: inFence ? 'code' : 'p', lang: fenceLang, text: fenceBuf.join('\n') });
  var html = '';
  for (var j = 0; j < blocks.length; j++) {
    var b = blocks[j];
    html += b.type === 'code' ? '<pre><code class="language-' + b.lang + '">' + he(b.text) + '</code></pre>' : rP(b.text);
  }
  return html;
}

function rP(text) {
  var lines = text.split('\n'), html = '', inList = null, inBq = false;
  function fl() { if (!inList) return ''; var t = inList === 'ul' ? '</ul>' : '</ol>'; inList = null; return t; }
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var hm = l.match(/^(#{1,4})\s+(.+)/); if (hm) { html += fl() + '<h' + hm[1].length + '>' + rI(hm[2]) + '</h' + hm[1].length + '>'; continue; }
    var bq = l.match(/^>\s?(.*)/); if (bq) { if (!inBq) { html += fl(); html += '<blockquote>'; inBq = true; } html += rI(bq[1]) + '<br>'; continue; }
    if (inBq) { html += '</blockquote>'; inBq = false; }
    var ul = l.match(/^[\-\*\+]\s+(.+)/); if (ul) { if (inList !== 'ul') { html += fl(); html += '<ul>'; inList = 'ul'; } html += '<li>' + rI(ul[1]) + '</li>'; continue; }
    var ol = l.match(/^(\d+)\.\s+(.+)/); if (ol) { if (inList !== 'ol') { html += fl(); html += '<ol>'; inList = 'ol'; } html += '<li>' + rI(ol[2]) + '</li>'; continue; }
    html += fl();
    if (l.match(/^[-*_]{3,}\s*$/)) { html += '<hr>'; continue; }
    if (l.trim() === '') { html += '<br>'; continue; }
    if (l.indexOf('|') >= 0 && l.trim().startsWith('|')) { html += rT(lines, i); while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim().startsWith('|')) i++; i--; continue; }
    html += '<p>' + rI(l) + '</p>';
  }
  return html + fl() + (inBq ? '</blockquote>' : '');
}

function rT(lines, s) {
  var rows = [];
  for (var i = s; i < lines.length; i++) { var l = lines[i].trim(); if (!l.startsWith('|')) break; rows.push(l.split('|').filter(function(_, idx, a) { return idx > 0 && idx < a.length - 1; })); }
  if (rows.length < 2) return '<p>' + rI(lines[s]) + '</p>';
  var h = '<table>';
  for (var r = 0; r < rows.length; r++) { h += '<tr>'; var t = r === 0 ? 'th' : 'td'; for (var c = 0; c < rows[r].length; c++) { if (r === 1 && rows[r][c].match(/^[-:]+$/)) break; h += '<' + t + '>' + rI(rows[r][c].trim()) + '</' + t + '>'; } h += '</tr>'; if (r === 1 && rows[1] && rows[1][0] && rows[1][0].match(/^[-:]+$/)) continue; }
  return h + '</table>';
}

function rI(t) {
  var s = he(t);
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  return s;
}

// === Scroll anchors (replaced below) ===
function setupScrollAnchors() { /* handled inline */ }

var anchorData = [];
var anchorFocusIdx = -1;

function updateAnchors(focusIdx) {
  var container = $s('#scrollAnchors');
  var rows = $s('#chatMessages').querySelectorAll('.msg-row.user');
  if (rows.length <= 1) { container.style.display = 'none'; anchorData = []; return; }

  anchorData = [];
  for (var i = 0; i < rows.length; i++) {
    var b = rows[i].querySelector('.msg-bubble');
    if (b) anchorData.push({ id: rows[i].id, text: b.textContent || '', el: rows[i] });
  }

  var maxDots = 8;
  var start = 0;
  if (focusIdx !== undefined && focusIdx >= 0) { anchorFocusIdx = focusIdx; }
  if (anchorFocusIdx >= 0 && anchorFocusIdx < anchorData.length) {
    start = Math.max(0, Math.min(anchorFocusIdx - Math.floor(maxDots / 2), anchorData.length - maxDots));
  } else if (anchorData.length > maxDots) {
    start = anchorData.length - maxDots;
  }

  var visible = anchorData.slice(start, start + maxDots);
  container.style.display = 'flex';

  // Animate existing dots out, then rebuild
  var oldDots = container.querySelectorAll('.anchor-dot');
  for (var j = 0; j < oldDots.length; j++) {
    oldDots[j].style.opacity = '0';
    oldDots[j].style.transform = 'scale(0.6)';
  }
  setTimeout(function() {
    container.innerHTML = '';
    for (var i = 0; i < visible.length; i++) {
      var gi = start + i;
      var dot = document.createElement('div');
      dot.className = 'anchor-dot';
      dot.style.opacity = '0';
      dot.style.transform = 'scale(0.6)';
      dot.setAttribute('data-idx', gi);
      dot.setAttribute('data-id', visible[i].id);

      var card = document.createElement('div');
      card.className = 'anchor-card';
      for (var k = 0; k < anchorData.length; k++) {
        var m = document.createElement('div');
        m.className = 'ac-msg' + (k === gi ? ' current' : ' other');
        m.textContent = anchorData[k].text.length > 60 ? anchorData[k].text.slice(0, 60) + '...' : anchorData[k].text;
        m.setAttribute('data-msgid', anchorData[k].id);
        m.addEventListener('click', function(e) {
          e.stopPropagation();
          closeAllCards();
          jumpToMsg(this.getAttribute('data-msgid'));
        });
        card.appendChild(m);
      }
      dot.appendChild(card);

    var timer;
    function showCard() {
      clearTimeout(timer);
      card.classList.add('show');
      var cur = card.querySelector('.ac-msg.current');
      if (cur) {
        requestAnimationFrame(function() {
          card.scrollTop = cur.offsetTop - card.clientHeight / 3;
        });
      }
    }
    function hideCard() { timer = setTimeout(function() { card.classList.remove('show'); }, 200); }
      dot.addEventListener('mouseenter', showCard);
      dot.addEventListener('mouseleave', hideCard);
      card.addEventListener('mouseenter', showCard);
      card.addEventListener('mouseleave', hideCard);

      dot.addEventListener('click', function() {
        closeAllCards();
        jumpToMsg(this.getAttribute('data-id'));
      });

      container.appendChild(dot);

      // Animate in with stagger
      (function(d, idx) {
        setTimeout(function() {
          d.style.transition = 'opacity .25s ease, transform .25s ease';
          d.style.opacity = '1';
          d.style.transform = 'scale(1)';
        }, idx * 30);
      })(dot, i);
    }
    highlightActive();
  }, 150);
}

function closeAllCards() {
  var cards = document.querySelectorAll('.anchor-card');
  for (var i = 0; i < cards.length; i++) { cards[i].classList.remove('show'); }
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('.anchor-dot') && !e.target.closest('.anchor-card')) {
    closeAllCards();
  }
});

function highlightActive() {
  var msgsEl = $s('#chatMessages');
  if (!msgsEl || anchorData.length === 0) return;
  var t = msgsEl.scrollTop;
  var b = t + msgsEl.clientHeight;
  // If user is at bottom viewing latest, highlight last message
  var atBottom = (msgsEl.scrollHeight - b) < 80;
  var best = -1;
  if (atBottom) {
    best = anchorData.length - 1;
  } else {
    for (var i = 0; i < anchorData.length; i++) {
      var el = anchorData[i].el; if (!el) continue;
      if (el.offsetTop + el.offsetHeight > t && el.offsetTop < b) { best = i; break; }
    }
    if (best < 0) best = anchorData.length - 1;
  }
  if (best < 0) best = anchorData.length - 1;
  var dots = document.querySelectorAll('.anchor-dot');
  for (var i = 0; i < dots.length; i++) {
    var idx = parseInt(dots[i].getAttribute('data-idx'));
    dots[i].classList.toggle('active', idx === best);
  }
}

function jumpToMsg(id) {
  var el = document.getElementById(id); if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.style.boxShadow = '0 0 0 3px rgba(99,102,241,.3)'; el.style.borderRadius = '8px';
  setTimeout(function() { el.style.boxShadow = ''; }, 1500);
  for (var i = 0; i < anchorData.length; i++) {
    if (anchorData[i].id === id) { updateAnchors(i); return; }
  }
}

function setupAutoScroll() {
  var msgs = $s('#chatMessages');
  msgs.addEventListener('wheel', function(e) { if (e.deltaY < -5) autoScroll = false; }, { passive: true });
  msgs.addEventListener('scroll', function() {
    var d = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight;
    if (d < 40) autoScroll = true;
    if (d > 120) autoScroll = false;
    // Update active anchor
    var rows = msgs.querySelectorAll('.msg-row.user');
    var v = [];
    for (var i = 0; i < rows.length; i++) { var b = rows[i].querySelector('.msg-bubble'); if (b) v.push({ id: rows[i].id, c: b.textContent || '' }); }
    if (anchorData.length > 0) highlightActive();
  });
}

function scrollToBottom(force) {
  if (force || autoScroll) requestAnimationFrame(function() { $s('#chatMessages').scrollTop = $s('#chatMessages').scrollHeight; });
}

// === Input ===
$s('#msgInput').addEventListener('input', function() { $s('#sendBtn').disabled = !this.value.trim() || isStreaming; autoResize(); });
function autoResize() { var t = $s('#msgInput'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; }
function handleInputKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }

// === Mobile ===
$s('#menuBtn').addEventListener('click', function() { $s('#sidebar').classList.toggle('mobile-open'); $s('#sidebarOverlay').classList.toggle('show'); });
$s('#sidebarOverlay').addEventListener('click', function() { $s('#sidebar').classList.remove('mobile-open'); $s('#sidebarOverlay').classList.remove('show'); });

function loadHighlight() {
  if (highlightLoaded) return;
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.id = 'hljs-theme';
  var t = document.documentElement.getAttribute('data-theme') || 'light';
  link.href = t === 'dark'
    ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css'
    : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
  document.head.appendChild(link);
  var script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js';
  script.onload = function() { highlightLoaded = true; };
  document.head.appendChild(script);
}
loadHighlight();

// Swap hljs theme on dark mode toggle
$s('#themeToggle').addEventListener('click', function() {
  var t = document.documentElement.getAttribute('data-theme') || 'light';
  var link = document.getElementById('hljs-theme');
  if (link) {
    link.href = t === 'dark'
      ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css'
      : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
  }
});

init();
