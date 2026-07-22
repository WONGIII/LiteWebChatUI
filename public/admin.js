const tc = document.getElementById('toastContainer');
function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'success');
  el.textContent = msg;
  tc.appendChild(el);
  setTimeout(function() { el.remove(); }, 3500);
}

async function checkAdmin() {
  try {
    var res = await fetch('/api/auth/me');
    if (res.ok) {
      var data = await res.json();
      if (data.user && data.user.is_admin) return;
    }
  } catch(e) {}
  window.location.href = '/login.html';
}
checkAdmin();

document.getElementById('logoutBtn').addEventListener('click', async function() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

async function loadProvider() {
  try {
    var res = await fetch('/api/admin/providers');
    var providers = await res.json();
    if (providers.length > 0) {
      var p = providers[0];
      document.getElementById('baseUrl').value = p.base_url || '';
      document.getElementById('providerName').value = p.name || '';
      document.getElementById('connStatus').innerHTML = '<div style="width:8px;height:8px;border-radius:50%;background:var(--success);"></div><span>已配置</span>';
    }
  } catch(e) {}
}
loadProvider();

document.getElementById('saveProviderBtn').addEventListener('click', async function() {
  var base_url = document.getElementById('baseUrl').value.trim();
  var api_key_val = document.getElementById('apiKey').value.trim();
  var name = document.getElementById('providerName').value.trim();
  if (!base_url) { toast('请填写 Base URL', 'error'); return; }
  if (!api_key_val) { toast('请填写 API Key', 'error'); return; }
  var res = await fetch('/api/admin/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, base_url: base_url, api_key: api_key_val })
  });
  if (res.ok) {
    toast('配置已保存');
    document.getElementById('connStatus').innerHTML = '<div style="width:8px;height:8px;border-radius:50%;background:var(--success);"></div><span>已配置</span>';
  } else {
    var d = await res.json();
    toast(d.error || '保存失败', 'error');
  }
});

document.getElementById('fetchModelsBtn').addEventListener('click', async function() {
  var pr = await fetch('/api/admin/providers');
  var providers = await pr.json();
  if (providers.length === 0) { toast('请先保存提供商配置', 'error'); return; }
  document.getElementById('fetchStatus').innerHTML = '<span class="spinner"></span> 获取中...';
  var res = await fetch('/api/admin/providers/' + providers[0].id + '/fetch', { method: 'POST' });
  var data = await res.json();
  document.getElementById('fetchStatus').textContent = '';
  if (res.ok) {
    toast('获取到 ' + data.count + ' 个模型');
    loadModels();
  } else {
    toast(data.error || '获取失败', 'error');
  }
});

var logoColors = ['#10a37f','#6366f1','#f59e0b','#ec4899','#8b5cf6','#06b6d4','#f97316','#14b8a6'];

async function loadModels() {
  var res = await fetch('/api/admin/models');
  var models = await res.json();
  var tbody = document.getElementById('modelTbody');
  if (models.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px;">暂无模型，请先配置提供商并获取模型列表</td></tr>';
    return;
  }
  tbody.innerHTML = models.map(function(m, i) {
    var logoHtml = '';
    if (m.logo_url) {
      logoHtml = '<img src="' + m.logo_url + '" style="width:32px;height:32px;border-radius:7px;object-fit:cover;position:absolute;top:0;left:0;">';
    }
    var placeholder = '<div class="admin-logo-placeholder" style="background:' + logoColors[i % logoColors.length] + ';">' + he((m.display_name || m.model_id).slice(0,2).toUpperCase()) + '</div>';
    return '<tr>' +
      '<td data-label="Logo"><div class="model-logo-cell"><div class="model-logo-upload' + (m.logo_url ? ' has-logo' : '') + '" onclick="uploadLogo(' + m.id + ')">' + logoHtml + placeholder + '</div></div></td>' +
      '<td data-label="名称"><input type="text" class="form-input" style="width:140px;padding:5px 8px;font-size:12px;" value="' + he(m.display_name || '') + '" onchange="updateModel(' + m.id + ',this)" placeholder="' + he(m.model_id) + '"></td>' +
      '<td data-label="模型ID" style="font-family:monospace;font-size:11px;">' + he(m.model_id) + '</td>' +
      '<td data-label="思考链"><div class="toggle-switch ' + (m.supports_reasoning ? 'on' : 'off') + '" onclick="toggleModel(' + m.id + ',\'supports_reasoning\',' + (m.supports_reasoning ? 0 : 1) + ')"></div></td>' +
      '<td data-label="可见性"><div class="toggle-switch ' + (m.visible ? 'on' : 'off') + '" onclick="toggleModel(' + m.id + ',\'visible\',' + (m.visible ? 0 : 1) + ')"></div><span style="margin-left:6px;font-size:12px;color:' + (m.visible ? 'var(--success)' : 'var(--text-muted)') + ';">' + (m.visible ? '公开' : '私密') + '</span></td>' +
    '</tr>';
  }).join('');
}

function he(s) {
  var d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

async function toggleModel(mid, field, val) {
  var body = {};
  body[field] = val;
  await fetch('/api/admin/models/' + mid, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  loadModels();
}

function updateModel(mid, el) {
  var val = el.value.trim();
  fetch('/api/admin/models/' + mid, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({display_name: val}) });
}

function uploadLogo(mid) {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/svg+xml,image/webp';
  input.onchange = async function() {
    var file = input.files[0];
    if (!file) return;
    var fd = new FormData();
    fd.append('logo', file);
    var res = await fetch('/api/admin/models/' + mid + '/logo', { method: 'POST', body: fd });
    if (res.ok) {
      toast('Logo 已更新');
      loadModels();
    } else {
      var d = await res.json();
      toast(d.error || '上传失败', 'error');
    }
  };
  input.click();
}

loadModels();
