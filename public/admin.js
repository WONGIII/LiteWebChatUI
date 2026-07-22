var tc = document.getElementById('toastContainer');
function toast(msg, type) {
  var el = document.createElement('div');
  el.className = 'toast ' + (type || 'success');
  el.textContent = msg;
  tc.appendChild(el);
  setTimeout(function() { el.remove(); }, 3500);
}

function he(s) {
  var d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

async function checkAdmin() {
  try {
    var res = await fetch('/api/auth/me');
    if (res.ok) {
      var data = await res.json();
      if (data.user && data.user.is_admin) return;
    }
  } catch(e) {}
  window.location.href = '/login';
}
checkAdmin();

document.getElementById('logoutBtn').addEventListener('click', async function() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

// ===== Providers =====
var allProviders = [];

async function loadProviders() {
  var res = await fetch('/api/admin/providers');
  allProviders = await res.json();
  renderProviders();
  updateProviderSelect();
}

function renderProviders() {
  var list = document.getElementById('providerList');
  if (allProviders.length === 0) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">暂无提供商，请添加</div>';
    return;
  }
  list.innerHTML = allProviders.map(function(p) {
    return '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border:1px solid var(--border-primary);border-radius:10px;margin-bottom:8px;background:var(--bg-primary);flex-wrap:wrap;">' +
      '<span style="font-weight:600;font-size:13px;">' + he(p.name || '未命名') + '</span>' +
      '<span style="font-family:monospace;font-size:11px;color:var(--text-tertiary);">' + he(p.base_url) + '</span>' +
      '<span style="font-size:11px;color:var(--text-muted);">' + he(p.api_key) + '</span>' +
      '<span style="flex:1;"></span>' +
      '<button class="btn btn-xs" onclick="fetchModels(' + p.id + ')">获取模型</button>' +
      '<button class="btn btn-xs btn-danger" onclick="deleteProvider(' + p.id + ')">删除</button>' +
    '</div>';
  }).join('');
}

function updateProviderSelect() {
  var sel = document.getElementById('customProviderId');
  sel.innerHTML = '<option value="">选择提供商</option>' + allProviders.map(function(p) {
    return '<option value="' + p.id + '">' + he(p.name || p.base_url) + '</option>';
  }).join('');
}

document.getElementById('addProviderBtn').addEventListener('click', async function() {
  var name = document.getElementById('providerName').value.trim();
  var base_url = document.getElementById('baseUrl').value.trim();
  var api_key = document.getElementById('apiKey').value.trim();
  if (!base_url) { toast('请填写 Base URL', 'error'); return; }
  if (!api_key) { toast('请填写 API Key', 'error'); return; }
  var res = await fetch('/api/admin/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, base_url: base_url, api_key: api_key })
  });
  if (res.ok) {
    toast('提供商已添加');
    document.getElementById('providerName').value = '';
    document.getElementById('baseUrl').value = '';
    document.getElementById('apiKey').value = '';
    loadProviders();
  } else {
    var d = await res.json();
    toast(d.error || '添加失败', 'error');
  }
});

async function fetchModels(pid) {
  var res = await fetch('/api/admin/providers/' + pid + '/fetch', { method: 'POST' });
  var data = await res.json();
  if (res.ok) { toast('获取到 ' + data.count + ' 个模型'); loadModels(); }
  else toast(data.error || '获取失败', 'error');
}

async function deleteProvider(pid) {
  if (!confirm('删除提供商将同时删除其下所有模型，确定？')) return;
  await fetch('/api/admin/providers/' + pid, { method: 'DELETE' });
  toast('已删除');
  loadProviders();
  loadModels();
}

// ===== Models =====
var logoColors = ['#10a37f','#6366f1','#f59e0b','#ec4899','#8b5cf6','#06b6d4','#f97316','#14b8a6'];
var allModels = [];

async function loadModels() {
  var res = await fetch('/api/admin/models');
  allModels = await res.json();
  var tbody = document.getElementById('modelTbody');
  document.getElementById('selectAllCheckbox').checked = false;
  if (allModels.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:24px;">暂无模型，请先添加提供商并获取模型列表</td></tr>';
    return;
  }
  tbody.innerHTML = allModels.map(function(m, i) {
    var logoHtml = '';
    if (m.logo_url) {
      logoHtml = '<img src="' + m.logo_url + '" style="width:100%;height:100%;object-fit:cover;position:absolute;top:0;left:0;border-radius:7px;">';
    }
    var placeholder = '<div class="admin-logo-placeholder" style="background:' + logoColors[i % logoColors.length] + ';">' + he((m.display_name || m.model_id).slice(0,2).toUpperCase()) + '</div>';
    return '<tr>' +
      '<td data-label="选择"><input type="checkbox" class="model-checkbox" value="' + m.id + '" style="cursor:pointer;"></td>' +
      '<td data-label="Logo"><div class="model-logo-cell"><div class="model-logo-upload' + (m.logo_url ? ' has-logo' : '') + '" onclick="uploadLogo(' + m.id + ')">' + logoHtml + placeholder + '</div></div></td>' +
      '<td data-label="名称"><input type="text" class="form-input" style="width:140px;padding:5px 8px;font-size:12px;" value="' + he(m.display_name || '') + '" onchange="updateModel(' + m.id + ',this)" placeholder="' + he(m.model_id) + '"></td>' +
      '<td data-label="模型ID" style="font-family:monospace;font-size:11px;">' + he(m.model_id) + (m.is_custom ? '<span style="font-size:9px;color:var(--success);margin-left:4px;">自定义</span>' : '') + '</td>' +
      '<td data-label="提供商" style="font-size:11px;color:var(--text-tertiary);">' + he(m.provider_name || '-') + '</td>' +
      '<td data-label="思考链"><div class="toggle-switch ' + (m.supports_reasoning ? 'on' : 'off') + '" onclick="toggleModel(' + m.id + ',\'supports_reasoning\',' + (m.supports_reasoning ? 0 : 1) + ')"></div></td>' +
      '<td data-label="可见性"><div class="toggle-switch ' + (m.visible ? 'on' : 'off') + '" onclick="toggleModel(' + m.id + ',\'visible\',' + (m.visible ? 0 : 1) + ')"></div><span style="margin-left:6px;font-size:12px;color:' + (m.visible ? 'var(--success)' : 'var(--text-muted)') + ';">' + (m.visible ? '公开' : '私密') + '</span></td>' +
      '<td data-label="操作"><button class="btn btn-xs btn-danger" onclick="deleteModel(' + m.id + ')">删除</button></td>' +
    '</tr>';
  }).join('');
}

async function deleteModel(mid) {
  await fetch('/api/admin/models/' + mid, { method: 'DELETE' });
  toast('已删除');
  loadModels();
}

async function toggleModel(mid, field, val) {
  var body = {};
  body[field] = val;
  await fetch('/api/admin/models/' + mid, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  loadModels();
}

function updateModel(mid, el) {
  fetch('/api/admin/models/' + mid, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({display_name: el.value.trim()}) });
}

function uploadLogo(mid) {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/svg+xml,image/webp';
  input.onchange = async function() {
    var file = input.files[0]; if (!file) return;
    var fd = new FormData(); fd.append('logo', file);
    var res = await fetch('/api/admin/models/' + mid + '/logo', { method: 'POST', body: fd });
    if (res.ok) { toast('Logo 已更新'); loadModels(); }
    else { var d = await res.json(); toast(d.error || '上传失败', 'error'); }
  };
  input.click();
}

// ===== Custom Model =====
document.getElementById('addCustomModelBtn').addEventListener('click', function() {
  updateProviderSelect();
  document.getElementById('customModelForm').style.display = 'block';
});

document.getElementById('saveCustomModelBtn').addEventListener('click', async function() {
  var pid = parseInt(document.getElementById('customProviderId').value) || 0;
  var mid = document.getElementById('customModelId').value.trim();
  var name = document.getElementById('customDisplayName').value.trim();
  var reasoning = document.getElementById('customSupportReasoning').checked;
  if (!pid) { toast('请选择提供商', 'error'); return; }
  if (!mid) { toast('请填写模型 ID', 'error'); return; }
  var res = await fetch('/api/admin/models/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider_id: pid, model_id: mid, display_name: name || mid, visible: 1, supports_reasoning: reasoning })
  });
  var data = await res.json();
  if (res.ok) {
    toast('模型已添加');
    document.getElementById('customModelForm').style.display = 'none';
    loadModels();
  } else {
    toast(data.error || '添加失败', 'error');
  }
});

// ===== Batch actions =====
function getChecked() {
  return Array.from(document.querySelectorAll('.model-checkbox:checked')).map(function(cb) { return parseInt(cb.value); });
}

async function batchSetVisible(mids, val) {
  for (var i = 0; i < mids.length; i++) {
    await fetch('/api/admin/models/' + mids[i], { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({visible: val}) });
  }
  loadModels();
}

async function batchSetVisibleAll(val) {
  var mids = allModels.map(function(m) { return m.id; });
  await batchSetVisible(mids, val);
}

document.getElementById('selectAllCheckbox').addEventListener('change', function() {
  var cbs = document.querySelectorAll('.model-checkbox');
  for (var i = 0; i < cbs.length; i++) cbs[i].checked = this.checked;
});
document.getElementById('selectAllBtn').addEventListener('click', function() {
  var cbs = document.querySelectorAll('.model-checkbox');
  for (var i = 0; i < cbs.length; i++) cbs[i].checked = true;
  document.getElementById('selectAllCheckbox').checked = true;
});
document.getElementById('deselectBtn').addEventListener('click', function() {
  var cbs = document.querySelectorAll('.model-checkbox');
  for (var i = 0; i < cbs.length; i++) cbs[i].checked = false;
  document.getElementById('selectAllCheckbox').checked = false;
});
document.getElementById('batchPublicBtn').addEventListener('click', function() {
  var ids = getChecked(); if (ids.length === 0) { toast('请先勾选模型', 'error'); return; }
  batchSetVisible(ids, 1); toast(ids.length + ' 个已设为公开');
});
document.getElementById('batchPrivateBtn').addEventListener('click', function() {
  var ids = getChecked(); if (ids.length === 0) { toast('请先勾选模型', 'error'); return; }
  batchSetVisible(ids, 0); toast(ids.length + ' 个已设为私密');
});
document.getElementById('allPublicBtn').addEventListener('click', function() {
  if (!confirm('确定将所有模型设为公开？')) return;
  batchSetVisibleAll(1); toast('全部已设为公开');
});
document.getElementById('allPrivateBtn').addEventListener('click', function() {
  if (!confirm('确定将所有模型设为私密？')) return;
  batchSetVisibleAll(0); toast('全部已设为私密');
});

// ===== User Management =====
async function loadUsers() {
  var res = await fetch('/api/admin/users');
  var users = await res.json();
  var tbody = document.getElementById('userTbody');
  tbody.innerHTML = users.map(function(u) {
    var role = u.is_admin ? '<span style="color:#6366f1;">管理员</span>' : '用户';
    var status = '';
    if (u.is_admin) {
      status = '<span style="color:var(--success);">-</span>';
    } else if (u.approved) {
      status = '<span style="color:var(--success);">已通过</span>';
    } else {
      status = '<span style="color:var(--warning);">待审核</span>';
    }
    var actions = '';
    if (!u.is_admin) {
      if (!u.approved) {
        actions = '<button class="btn btn-xs" style="background:var(--success);color:#fff;border-color:var(--success);" onclick="approveUser(' + u.id + ',1)">通过</button>';
      } else {
        actions = '<button class="btn btn-xs" style="background:var(--warning);color:#fff;border-color:var(--warning);" onclick="approveUser(' + u.id + ',0)">驳回</button>';
      }
      actions += ' <button class="btn btn-xs btn-danger" onclick="deleteUser(' + u.id + ')">删除</button>';
    }
    return '<tr>' +
      '<td data-label="邮箱">' + he(u.email) + '</td>' +
      '<td data-label="角色">' + role + '</td>' +
      '<td data-label="状态">' + status + '</td>' +
      '<td data-label="注册时间" style="font-size:11px;color:var(--text-muted);">' + he(u.created_at || '') + '</td>' +
      '<td data-label="操作">' + actions + '</td>' +
    '</tr>';
  }).join('');
}

async function approveUser(uid, val) {
  await fetch('/api/admin/users/' + uid, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({approved: val}) });
  toast(val ? '已通过' : '已驳回');
  loadUsers();
}

async function deleteUser(uid) {
  if (!confirm('确定删除该用户？此操作不可撤销。')) return;
  await fetch('/api/admin/users/' + uid, { method: 'DELETE' });
  toast('已删除');
  loadUsers();
}

// ===== Init =====
loadProviders();
loadModels();
loadUsers();
