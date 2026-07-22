// === State ===
var currentUser = null;
var currentModel = null;
var currentConvId = null;
var models = [];
var conversations = [];
var autoScroll = true;
var isStreaming = false;
var highlightLoaded = false;

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
    if (!res.ok) { window.location.href = '/login.html'; return; }
    var data = await res.json();
    currentUser = data.user;
    $s('#userEmail').textContent = currentUser.email;
    $s('#userAvatar').textContent = (currentUser.email || 'U')[0].toUpperCase();
    if (currentUser.is_admin) $s('#adminLink').style.display = '';
    await loadModels();
    await loadConversations();
    setupAutoScroll();
  } catch(e) { window.location.href = '/login.html'; }
}

$s('#logoutBtn').addEventListener('click', async function() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
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
  if (visible.length === 0) {
    $s('#modelDropdown').innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text-muted);">暂无可用模型</div>';
    return;
  }
  var html = '';
  var colors = ['#10a37f','#6366f1','#f59e0b','#ec4899','#8b5cf6','#06b6d4','#f97316'];
  for (var i = 0; i < visible.length; i++) {
    var m = visible[i];
    var logoHtml = '';
    if (m.logo_url) {
      logoHtml = '<img src="' + m.logo_url + '" width="20" height="20" style="border-radius:5px;object-fit:cover;">';
    } else {
      logoHtml = '<div class="model-logo-placeholder" style="background:' + colors[i % colors.length] + ';">' + he((m.display_name || m.model_id).slice(0,2).toUpperCase()) + '</div>';
    }
    var sel = currentModel && currentModel.model_id === m.model_id ? ' selected' : '';
    html += '<div class="model-dropdown-item' + sel + '" data-mid="' + he(m.model_id) + '" onclick="selectModelById(\'' + he_q(m.model_id) + '\')">' + logoHtml + '<span>' + he(m.display_name || m.model_id) + '</span></div>';
  }
  $s('#modelDropdown').innerHTML = html;
}

function selectModel(m) {
  currentModel = m;
  $s('#modelSelectName').textContent = m.display_name || m.model_id;
  var logo = $s('#modelSelectLogo');
  if (m.logo_url) { logo.src = m.logo_url; logo.style.display = ''; }
  else { logo.style.display = 'none'; }
  $s('#modelDropdown').style.display = 'none';
}

function selectModelById(id) {
  var m = models.find(function(x) { return x.model_id === id; });
  if (m) selectModel(m);
}

$s('#modelSelectBtn').addEventListener('click', function(e) {
  e.stopPropagation();
  var dd = $s('#modelDropdown');
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
});
document.addEventListener('click', function() { $s('#modelDropdown').style.display = 'none'; });

// === Conversations ===
async function loadConversations() {
  try {
    var res = await fetch('/api/conversations');
    conversations = await res.json();
    renderConvList();
  } catch(e) {}
}

function renderConvList() {
  var html = '';
  for (var i = 0; i < conversations.length; i++) {
    var c = conversations[i];
    var active = c.id === currentConvId ? ' active' : '';
    html += '<div class="conv-item' + active + '" onclick="openConversation(' + c.id + ')">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
      '<span class="conv-title">' + he(c.title || '新对话') + '</span>' +
      '<span class="conv-delete" onclick="event.stopPropagation();deleteConv(' + c.id + ')">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
      '</span>' +
    '</div>';
  }
  $s('#convList').innerHTML = html;
}

async function newConversation() {
  if (!currentModel) return;
  var res = await fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: currentModel.model_id })
  });
  var conv = await res.json();
  conversations.unshift(conv);
  currentConvId = conv.id;
  $s('#chatMessages').innerHTML = '<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><h3>新对话</h3><p>在下方输入消息开始</p></div>';
  renderConvList();
}

$s('#newChatBtn').addEventListener('click', newConversation);

async function openConversation(id) {
  currentConvId = id;
  renderConvList();
  try {
    var res = await fetch('/api/conversations/' + id + '/messages');
    var messages = await res.json();
    $s('#chatMessages').innerHTML = '';
    for (var i = 0; i < messages.length; i++) {
      appendMessage(messages[i].role, messages[i].content, messages[i].reasoning);
    }
    scrollToBottom(true);
  } catch(e) {}
}

async function deleteConv(id) {
  await fetch('/api/conversations/' + id, { method: 'DELETE' });
  conversations = conversations.filter(function(c) { return c.id !== id; });
  if (currentConvId === id) {
    currentConvId = null;
    $s('#chatMessages').innerHTML = '<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><h3>开始对话</h3><p>选择模型后开始</p></div>';
  }
  renderConvList();
}

// === Send Message ===
async function sendMessage() {
  if (isStreaming) return;
  var input = $s('#msgInput');
  var content = input.value.trim();
  if (!content) return;
  if (!currentModel) return;
  if (!currentConvId) await newConversation();
  if (!currentConvId) return;

  input.value = '';
  autoResize();
  $s('#sendBtn').disabled = true;
  isStreaming = true;

  var msgs = $s('#chatMessages');
  if (msgs.querySelector('.empty-state')) msgs.innerHTML = '';

  appendMessage('user', content, null);

  var aId = 'a' + Date.now();
  var logoHtml = '';
  if (currentModel.logo_url) {
    logoHtml = '<div class="msg-avatar-model"><img src="' + currentModel.logo_url + '" alt=""></div>';
  } else {
    logoHtml = '<div class="msg-avatar">AI</div>';
  }

  msgs.insertAdjacentHTML('beforeend',
    '<div class="msg-row assistant" id="' + aId + '">' +
    logoHtml +
    '<div class="msg-body" id="' + aId + '-body"></div>' +
    '</div>'
  );
  scrollToBottom(true);

  try {
    var history = [];
    var allMsgs = msgs.querySelectorAll('.msg-row');
    allMsgs.forEach(function(row) {
      if (row.classList.contains('user')) {
        var b = row.querySelector('.msg-bubble');
        if (b) history.push({ role: 'user', content: b.textContent });
      }
    });

    var res = await fetch('/api/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: currentConvId, model: currentModel.model_id, messages: history })
    });

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var reasoning = '';
    var fullContent = '';
    var reasoningSent = false;
    var reasoningEl = null;
    var bodyEl = document.getElementById(aId + '-body');

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      var text = decoder.decode(chunk.value, { stream: true });
      var lines = text.split('\n');
      var evt = '';
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.startsWith('event:')) {
          evt = line.slice(6).trim();
        } else if (line.startsWith('data:') && evt) {
          try {
            var payload = JSON.parse(line.slice(5).trim());
            if (evt === 'reasoning') {
              reasoning += payload.delta;
              if (!reasoningEl) {
                bodyEl.insertAdjacentHTML('beforeend',
                  '<div class="think-streaming" id="' + aId + '-think">' +
                  '<div class="think-bar"></div>' +
                  '<div style="flex:1;">' +
                  '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:3px;">正在思考 <span class="think-dots"><span></span><span></span><span></span></span></div>' +
                  '<div class="think-content" id="' + aId + '-think-content"></div>' +
                  '</div></div>'
                );
                reasoningEl = document.getElementById(aId + '-think');
              }
              var tc = document.getElementById(aId + '-think-content');
              if (tc) tc.textContent = reasoning;
              reasoningSent = true;
            } else if (evt === 'reasoning_done') {
              if (reasoningEl) reasoningEl.remove();
              if (reasoning) {
                bodyEl.insertAdjacentHTML('afterbegin',
                  '<div class="think-collapsed" id="' + aId + '-think-done" data-reasoning="' + he_a(reasoning) + '" onclick="toggleThink(\'' + aId + '\')">' +
                  '<div class="think-bar"></div><span>已深度思考</span>' +
                  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform:rotate(180deg);"><path d="m18 15-6-6-6 6"/></svg>' +
                  '</div>'
                );
              }
            } else if (evt === 'content') {
              fullContent += payload.delta;
              var contentEl = document.getElementById(aId + '-content');
              if (!contentEl) {
                bodyEl.insertAdjacentHTML('beforeend',
                  '<div class="msg-content" id="' + aId + '-content"></div>'
                );
                contentEl = document.getElementById(aId + '-content');
              }
              contentEl.innerHTML = renderMd(fullContent);
              if (highlightLoaded) {
                var codes = contentEl.querySelectorAll('pre code');
                codes.forEach(function(b) { if (window.hljs) hljs.highlightElement(b); });
              }
            } else if (evt === 'done') {
              if (fullContent) {
                var title = fullContent.replace(/\n/g, ' ').slice(0, 30).trim();
                updateConvTitle(currentConvId, title);
              }
              loadConversations();
            } else if (evt === 'error') {
              bodyEl.insertAdjacentHTML('beforeend',
                '<div style="color:var(--danger);font-size:13px;padding:8px 0;">' + he(payload.message || '请求失败') + '</div>'
              );
            }
          } catch(e) {}
          evt = '';
        }
      }
      scrollToBottom(false);
    }
  } catch(err) {
    $s('#chatMessages').insertAdjacentHTML('beforeend',
      '<div style="color:var(--danger);font-size:13px;padding:10px;">发送失败: ' + he(err.message || '') + '</div>'
    );
  } finally {
    isStreaming = false;
    $s('#sendBtn').disabled = false;
    $s('#msgInput').focus();
    scrollToBottom(false);
  }
}

// === Toggle thinking ===
function toggleThink(aId) {
  var collapsed = document.getElementById(aId + '-think-done');
  var expanded = document.getElementById(aId + '-think-expanded');
  if (expanded) {
    expanded.remove();
    if (collapsed) collapsed.style.display = '';
    return;
  }
  if (!collapsed) return;
  var reasoning = collapsed.getAttribute('data-reasoning') || '';
  var bodyEl = document.getElementById(aId + '-body');
  var contentEl = document.getElementById(aId + '-content');
  var html = '<div class="think-expanded" id="' + aId + '-think-expanded">' +
    '<div class="think-bar"></div>' +
    '<div style="flex:1;">' +
    '<div class="think-header" onclick="toggleThink(\'' + aId + '\')"><span>已深度思考</span>' +
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 15-6-6-6 6"/></svg></div>' +
    '<div class="think-content">' + renderMd(reasoning) + '</div>' +
    '</div></div>';
  collapsed.style.display = 'none';
  if (contentEl) {
    contentEl.insertAdjacentHTML('beforebegin', html);
  } else {
    bodyEl.insertAdjacentHTML('beforeend', html);
  }
}

// === Append static message ===
function appendMessage(role, content, reasoning) {
  var msgs = $s('#chatMessages');
  if (msgs.querySelector('.empty-state')) msgs.innerHTML = '';
  var id = 'm' + Date.now() + Math.random().toString(36).slice(2,6);
  if (role === 'user') {
    msgs.insertAdjacentHTML('beforeend',
      '<div class="msg-row user"><div class="msg-bubble user">' + he(content) + '</div></div>'
    );
  } else {
    var logoHtml = '';
    if (currentModel && currentModel.logo_url) {
      logoHtml = '<div class="msg-avatar-model"><img src="' + currentModel.logo_url + '" alt=""></div>';
    } else {
      logoHtml = '<div class="msg-avatar">AI</div>';
    }
    var thinkHtml = '';
    if (reasoning) {
      thinkHtml = '<div class="think-collapsed" data-reasoning="' + he_a(reasoning) + '" id="' + id + '-think-done" onclick="toggleThink(\'' + id + '\')">' +
        '<div class="think-bar"></div><span>已深度思考</span>' +
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform:rotate(180deg);"><path d="m18 15-6-6-6 6"/></svg>' +
        '</div>';
    }
    msgs.insertAdjacentHTML('beforeend',
      '<div class="msg-row assistant" id="' + id + '">' +
      logoHtml +
      '<div class="msg-body" id="' + id + '-body">' +
      thinkHtml +
      '<div class="msg-content" id="' + id + '-content">' + renderMd(content) + '</div>' +
      '</div></div>'
    );
    if (highlightLoaded) {
      var codes = document.querySelectorAll('#' + id + '-content pre code');
      codes.forEach(function(b) { if (window.hljs) hljs.highlightElement(b); });
    }
  }
  scrollToBottom(true);
}

async function updateConvTitle(convId, title) {
  var c = conversations.find(function(x) { return x.id === convId; });
  if (c) { c.title = title; renderConvList(); }
  try {
    await fetch('/api/conversations/' + convId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title })
    });
  } catch(e) {}
}

// === Helpers ===
function he(s) {
  var d = document.createElement('div');
  d.textContent = (s || '');
  return d.innerHTML;
}
function he_a(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function he_q(s) { return (s || '').replace(/'/g, "\\'"); }

function renderMd(text) {
  if (!text) return '';
  var html = he(text);
  // Code blocks with copy button
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code) {
    return '<pre><code class="language-' + (lang || '') + '">' + he(code.trim()) + '</code><button class="copy-btn" onclick="copyCode(this)">复制</button></pre>';
  });
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Newlines
  html = html.replace(/\n/g, '<br>');
  return html;
}

window.copyCode = function(btn) {
  var code = btn.parentElement.querySelector('code');
  if (!code) return;
  var text = code.textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      btn.textContent = '已复制';
      setTimeout(function() { btn.textContent = '复制'; }, 1500);
    });
  } else {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = '已复制';
    setTimeout(function() { btn.textContent = '复制'; }, 1500);
  }
};

// === Auto-scroll ===
function setupAutoScroll() {
  var msgs = $s('#chatMessages');
  msgs.addEventListener('wheel', function(e) {
    if (e.deltaY < -5) autoScroll = false;
  }, { passive: true });
  msgs.addEventListener('scroll', function() {
    var d = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight;
    if (d < 40) autoScroll = true;
    if (d > 120) autoScroll = false;
  });
}

function scrollToBottom(force) {
  if (force || autoScroll) {
    requestAnimationFrame(function() {
      $s('#chatMessages').scrollTop = $s('#chatMessages').scrollHeight;
    });
  }
}

// === Input ===
$s('#msgInput').addEventListener('input', function() {
  $s('#sendBtn').disabled = !this.value.trim() || isStreaming;
  autoResize();
});

function autoResize() {
  var t = $s('#msgInput');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 160) + 'px';
}

function handleInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

// === Mobile sidebar ===
$s('#menuBtn').addEventListener('click', function() {
  $s('#sidebar').classList.toggle('mobile-open');
  $s('#sidebarOverlay').classList.toggle('show');
});
$s('#sidebarOverlay').addEventListener('click', function() {
  $s('#sidebar').classList.remove('mobile-open');
  $s('#sidebarOverlay').classList.remove('show');
});

// Highlight.js lazy load
function loadHighlight() {
  if (highlightLoaded) return;
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
  document.head.appendChild(link);
  var script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js';
  script.onload = function() { highlightLoaded = true; };
  document.head.appendChild(script);
}
loadHighlight();

init();
