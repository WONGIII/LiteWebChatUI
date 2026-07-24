let isRegister = false;
const form = document.getElementById('authForm');
const email = document.getElementById('email');
const password = document.getElementById('password');
const formError = document.getElementById('formError');
const submitBtn = document.getElementById('submitBtn');
const pageTitle = document.getElementById('pageTitle');
const pageSubtitle = document.getElementById('pageSubtitle');
const toggleMode = document.getElementById('toggleMode');
const modeSwitch = document.getElementById('modeSwitch');

async function init() {
  try {
    const meRes = await fetch('/api/auth/me');
    if (meRes.ok) {
      const meData = await meRes.json();
      if (meData.user) {
        window.location.href = meData.user.is_admin ? '/admin' : '/chat';
        return;
      }
    }
  } catch (e) {}
  try {
    const res = await fetch('/api/auth/needs-setup');
    const data = await res.json();
    if (data.needsSetup) {
      pageTitle.textContent = '创建管理员账号';
      pageSubtitle.textContent = '首次使用，请设置管理员账号';
      submitBtn.textContent = '创建账号';
      modeSwitch.style.display = 'none';
      isRegister = true;
    }
  } catch (e) { formError.textContent = '无法连接服务器，请确认已启动'; }
}
init();

function onToggle(e) {
  e.preventDefault();
  isRegister = !isRegister;
  if (isRegister) {
    submitBtn.textContent = '注册';
    pageSubtitle.textContent = '创建新账号';
    modeSwitch.innerHTML = '已有账号？<a href="#" id="toggleMode">去登录</a>';
    document.getElementById('toggleMode').addEventListener('click', onToggle);
  } else {
    submitBtn.textContent = '登录';
    pageSubtitle.textContent = '轻量 AI 对话';
    modeSwitch.innerHTML = '没有账号？<a href="#" id="toggleMode">去注册</a>';
    document.getElementById('toggleMode').addEventListener('click', onToggle);
  }
}
toggleMode.addEventListener('click', onToggle);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';
  submitBtn.disabled = true;
  const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value.trim(), password: password.value })
    });
    const data = await res.json();
    if (!res.ok) { formError.textContent = data.error || '请求失败'; return; }
    if (data.csrfToken) localStorage.setItem('csrfToken', data.csrfToken);
    if (data.user && data.user.is_admin) {
      window.location.href = '/admin';
    } else if (isRegister) {
      formError.style.color = 'var(--success)';
      formError.textContent = '注册成功！请等待管理员审核通过后使用';
      submitBtn.style.display = 'none';
      document.getElementById('password').style.display = 'none';
      document.getElementById('email').disabled = true;
    } else {
      window.location.href = '/chat';
    }
  } catch (err) {
    formError.textContent = '网络错误，请确认服务器已启动';
  } finally {
    submitBtn.disabled = false;
  }
});
