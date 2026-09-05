const $ = (selector) => document.querySelector(selector);

const state = {
  user: null,
  account: null,
  bots: [],
  ssid: sessionStorage.getItem('abeam_ssid') || '',
  authMode: 'login',
  refreshTimer: null,
};

function setVisible(selector, visible) {
  $(selector)?.classList.toggle('hidden', !visible);
}

function showNotice(message, type = 'info') {
  const notice = $('#notice');
  if (!notice) return;
  notice.textContent = message;
  notice.classList.toggle('error', type === 'error');
  notice.classList.remove('hidden');
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => notice.classList.add('hidden'), 6500);
}

function setConnection(online) {
  const pill = $('#connection-pill');
  if (!pill) return;
  pill.classList.toggle('online', online);
  pill.classList.toggle('offline', !online);
  pill.innerHTML = `<i></i> ${online ? 'api online' : 'api offline'}`;
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.ssid) headers.set('Authorization', `Bearer ${state.ssid}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, headers, credentials: 'include' });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || response.statusText }; }
  if (!response.ok) {
    const error = new Error(data.message || data.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function friendlyError(error) {
  if (error?.data?.message) return error.data.message;
  if (error?.data?.error) return String(error.data.error).replaceAll('_', ' ');
  return error?.message || 'Something went wrong';
}

function showAuth() {
  setVisible('#auth-view', true);
  setVisible('#dashboard-view', false);
  $('#logout-button')?.classList.add('hidden');
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  setConnection(true);
}

function showDashboard() {
  setVisible('#auth-view', false);
  setVisible('#dashboard-view', true);
  $('#logout-button')?.classList.remove('hidden');
  if (!state.refreshTimer) state.refreshTimer = setInterval(() => loadDashboard(true), 9000);
}

function setAuthMode(mode) {
  state.authMode = mode;
  const signup = mode === 'signup';
  $('#auth-title').textContent = signup ? 'Create account' : 'Sign in';
  $('#auth-subtitle').textContent = signup ? 'Create an account to manage your fleet.' : 'Access your bot fleet.';
  $('#auth-submit').textContent = signup ? 'Create account' : 'Sign in';
  $('#auth-toggle').textContent = signup ? 'Already have an account? Sign in' : 'Need an account? Create one';
  $('#auth-password').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
}

async function loadIdentity() {
  try {
    const web = await api('/api/me/web');
    if (web.user) {
      state.user = web.user;
      return true;
    }
  } catch (error) {
    setConnection(false);
  }

  if (state.ssid) {
    try {
      const me = await api('/api/me');
      state.user = { email: me.email, username: me.email.split('@')[0], via: 'ssid' };
      return true;
    } catch {
      state.ssid = '';
      sessionStorage.removeItem('abeam_ssid');
    }
  }
  state.user = null;
  return false;
}

async function signIn(event) {
  event.preventDefault();
  const button = $('#auth-submit');
  button.disabled = true;
  try {
    const endpoint = state.authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    await api(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        email: $('#auth-email').value.trim(),
        password: $('#auth-password').value,
      }),
    });
    state.ssid = '';
    sessionStorage.removeItem('abeam_ssid');
    await loadDashboard();
  } catch (error) {
    showAuth();
    showNotice(friendlyError(error), 'error');
  } finally {
    button.disabled = false;
  }
}

async function signInWithSsid(event) {
  event.preventDefault();
  const value = $('#ssid-input').value.trim();
  if (!value) return showNotice('Paste an SSID first.', 'error');
  state.ssid = value;
  sessionStorage.setItem('abeam_ssid', value);
  try {
    await loadDashboard();
  } catch (error) {
    state.ssid = '';
    sessionStorage.removeItem('abeam_ssid');
    showAuth();
    showNotice(friendlyError(error), 'error');
  }
}

function renderAccount() {
  const account = state.account || {};
  const subscriber = account.subscriber;
  const bots = state.bots;
  const online = bots.filter((bot) => bot.status === 'online').length;
  $('#metric-online').textContent = String(online);
  $('#metric-slots').textContent = `${bots.length} / ${account.slots < 0 ? '∞' : (account.slots || 0)}`;
  $('#metric-entitlement').textContent = account.entitlement === 'active' ? 'ACTIVE' : 'NONE';
  $('#metric-plan').textContent = subscriber?.planName || 'No active plan';
  $('#metric-expires').textContent = subscriber?.expiresAt ? `expires ${new Date(subscriber.expiresAt).toLocaleDateString()}` : (subscriber ? 'active entitlement' : 'Sign in to continue');
  $('#account-status').textContent = account.entitlement === 'active' ? 'active' : 'no plan';
  $('#account-status').className = `status-chip ${account.entitlement === 'active' ? 'online' : 'offline'}`;

  const details = $('#account-details');
  details.replaceChildren();
  const rows = [
    ['Plan', subscriber?.planName || 'No active plan'],
    ['Bot slots', account.slots < 0 ? 'Unlimited' : `${bots.length} used of ${account.slots || 0}`],
    ['AI credits', subscriber?.credits?.unlimited ? 'Unlimited' : String(subscriber?.credits?.balance ?? 0)],
    ['Account', state.user?.via === 'ssid' ? 'SSID session' : 'Web session'],
  ];
  rows.forEach(([label, value]) => {
    const line = document.createElement('div');
    line.className = 'detail-line';
    const a = document.createElement('span');
    const b = document.createElement('span');
    a.textContent = label;
    b.textContent = value;
    line.append(a, b);
    details.append(line);
  });
}

function statusClass(status) {
  return ['online', 'connecting', 'error', 'offline'].includes(status) ? status : 'offline';
}

function formatLogs(logs) {
  if (!logs?.length) return 'No runtime logs yet.';
  return logs.map((entry) => {
    const time = entry.ts ? new Date(entry.ts).toLocaleTimeString() : '--:--:--';
    return `${time}  ${String(entry.level || 'system').padEnd(7)} ${entry.line || ''}`;
  }).join('\n');
}

async function loadConsole(card, bot) {
  const consoleBox = card.querySelector('.bot-console');
  const logs = card.querySelector('.bot-logs');
  try {
    const data = await api(`/api/bots/${bot.id}/console`);
    logs.textContent = formatLogs(data.logs);
    consoleBox.classList.remove('hidden');
    card.querySelector('.bot-console-button').textContent = 'Hide console';
    logs.scrollTop = logs.scrollHeight;
  } catch (error) {
    showNotice(friendlyError(error), 'error');
  }
}

function renderBots() {
  const list = $('#bot-list');
  const empty = $('#empty-state');
  list.replaceChildren();
  $('#fleet-count').textContent = `${state.bots.length} bot${state.bots.length === 1 ? '' : 's'}`;
  empty.classList.toggle('hidden', state.bots.length > 0);

  const template = $('#bot-card-template');
  state.bots.forEach((bot) => {
    const card = template.content.cloneNode(true);
    const root = card.querySelector('.bot-card');
    const status = statusClass(bot.status);
    root.dataset.id = bot.id;
    root.querySelector('.bot-name').textContent = bot.name || bot.username || 'Unnamed bot';
    root.querySelector('.bot-address').textContent = `${bot.host}:${bot.port}`;
    root.querySelector('.bot-status').textContent = status;
    root.querySelector('.bot-status').classList.add(status);
    root.querySelector('.bot-engine').textContent = bot.engine || 'azalea';
    root.querySelector('.bot-user').textContent = bot.username || 'profile pending';
    root.querySelector('.bot-created').textContent = bot.createdAt ? new Date(bot.createdAt).toLocaleDateString() : 'new';

    const error = root.querySelector('.bot-error');
    if (bot.lastError) {
      error.textContent = bot.lastError;
      error.classList.remove('hidden');
    }

    const start = root.querySelector('.bot-start-button');
    const stop = root.querySelector('.bot-stop-button');
    start.classList.toggle('hidden', bot.enabled || status === 'connecting' || status === 'online');
    stop.classList.toggle('hidden', !bot.enabled && status !== 'online' && status !== 'connecting');
    start.addEventListener('click', async () => {
      start.disabled = true;
      try { await api(`/api/bots/${bot.id}/start`, { method: 'POST' }); await loadDashboard(true); }
      catch (e) { showNotice(friendlyError(e), 'error'); start.disabled = false; }
    });
    stop.addEventListener('click', async () => {
      stop.disabled = true;
      try { await api(`/api/bots/${bot.id}/stop`, { method: 'POST' }); await loadDashboard(true); }
      catch (e) { showNotice(friendlyError(e), 'error'); stop.disabled = false; }
    });

    const consoleButton = root.querySelector('.bot-console-button');
    consoleButton.addEventListener('click', async () => {
      const box = root.querySelector('.bot-console');
      if (box.classList.contains('hidden')) await loadConsole(root, bot);
      else { box.classList.add('hidden'); consoleButton.textContent = 'Console'; }
    });
    root.querySelector('.chat-button').addEventListener('click', async () => {
      const input = root.querySelector('.chat-input');
      const message = input.value.trim();
      if (!message) return;
      try {
        await api(`/api/bots/${bot.id}/console`, { method: 'POST', body: JSON.stringify({ message }) });
        input.value = '';
        await loadConsole(root, bot);
      } catch (e) { showNotice(friendlyError(e), 'error'); }
    });
    root.querySelector('.chat-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') root.querySelector('.chat-button').click();
    });
    root.querySelector('.bot-delete-button').addEventListener('click', async () => {
      if (!window.confirm(`Delete ${bot.name || bot.username || 'this bot'}?`)) return;
      try { await api(`/api/bots/${bot.id}`, { method: 'DELETE' }); await loadDashboard(true); }
      catch (e) { showNotice(friendlyError(e), 'error'); }
    });
    list.append(card);
  });
}

async function loadDashboard(silent = false) {
  const identified = await loadIdentity();
  if (!identified) {
    showAuth();
    return;
  }
  showDashboard();
  $('#user-name').textContent = state.user.username || state.user.email?.split('@')[0] || 'operator';
  $('#user-email').textContent = state.user.email || '';
  try {
    const [account, bots] = await Promise.all([api('/api/account'), api('/api/bots')]);
    state.account = { ...account, slots: bots.slots };
    state.bots = bots.bots || [];
    renderAccount();
    renderBots();
    setConnection(true);
  } catch (error) {
    setConnection(error.status !== 401);
    if (error.status === 401) {
      state.user = null;
      showAuth();
    } else if (!silent) showNotice(friendlyError(error), 'error');
  }
}

async function createBot(event) {
  event.preventDefault();
  const button = event.submitter || $('#create-bot-form button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/bots', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#bot-name').value.trim(),
        token: $('#bot-token').value.trim(),
        host: $('#bot-host').value.trim(),
        port: Number($('#bot-port').value) || 25565,
        version: $('#bot-version').value,
        engine: 'azalea',
        proxy: $('#bot-proxy').value.trim(),
        antiAfk: $('#bot-anti-afk').checked,
      }),
    });
    $('#create-bot-form').reset();
    $('#bot-port').value = '25565';
    showNotice('Azalea bot created. It is validating the Minecraft token and connecting now.');
    await loadDashboard(true);
  } catch (error) {
    showNotice(friendlyError(error), 'error');
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  try { await fetch('/logout', { credentials: 'include' }); } catch {}
  state.user = null;
  state.ssid = '';
  sessionStorage.removeItem('abeam_ssid');
  showAuth();
}

$('#auth-form').addEventListener('submit', signIn);
$('#auth-toggle').addEventListener('click', () => setAuthMode(state.authMode === 'login' ? 'signup' : 'login'));
$('#ssid-form').addEventListener('submit', signInWithSsid);
$('#create-bot-form').addEventListener('submit', createBot);
$('#logout-button').addEventListener('click', logout);
$('#refresh-button').addEventListener('click', () => loadDashboard(false));

setAuthMode('login');
loadDashboard();
