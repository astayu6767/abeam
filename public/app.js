/* abeam operator UI. The browser only receives public bot metadata; Minecraft
   tokens, proxy credentials and backend secrets stay in the API process. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = {
    user: null,
    account: null,
    plans: [],
    bots: [],
    slots: 0,
    activePanel: 'bots',
    activeBotId: null,
    editingBotId: null,
    invoice: null,
    invoiceTimer: null,
    invoiceCountdown: null,
    botTimer: null,
    detailTimer: null,
    detailTab: 'console',
    detailView: null,
    authMode: 'login',
  };

  const fallbackPlans = [
    { id: 'ace', name: 'Ace', priceUsd: 5, botSlots: 1, monthlyCredits: 0, tagline: 'One clean shot.', features: ['1 managed bot slot', 'Any Minecraft server', 'Unlimited targets', 'Keyword replies', 'Live console'] },
    { id: 'raid', name: 'Raid', priceUsd: 8, botSlots: 4, monthlyCredits: 500, popular: true, tagline: 'The crew that grinds brackets.', features: ['4 managed bot slots', 'Any Minecraft server', 'Unlimited targets', 'Beam AI rewrites', 'Advanced conversation flow', 'Priority queue', 'Live console per bot'] },
    { id: 'storm', name: 'Storm', priceUsd: 16, botSlots: 12, monthlyCredits: 2500, tagline: 'Flood the whole lobby.', features: ['12 managed bot slots', 'Any Minecraft server', 'Unlimited targets', 'Beam AI rewrites', 'Custom persona + scripts', 'Priority support', 'API + webhooks'] },
  ];

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatTime(value) {
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function cleanConsoleLine(value) {
    return String(value ?? '')
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\[[0-9;?]*m/g, '')
      .replace(/§[0-9A-FK-OR]/gi, '')
      .replace(/\r/g, '');
  }

  function toast(message, timeout = 3000) {
    const node = $('toast');
    node.textContent = message;
    node.hidden = false;
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => { node.hidden = true; }, timeout);
  }

  function showError(message) {
    const node = $('err-banner');
    node.textContent = message;
    node.hidden = !message;
    if (message) window.setTimeout(() => { node.hidden = true; }, 7000);
  }

  async function api(url, options = {}) {
    const config = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
    if (options.body && typeof options.body !== 'string') {
      config.body = JSON.stringify(options.body);
      config.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, config);
    let payload = null;
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) {
      const message = payload?.message || payload?.error || `Request failed (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function openModal(id) {
    const modal = $(id);
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add('modal-open');
    const focusable = modal.querySelector('input, textarea, select, button');
    if (focusable) window.setTimeout(() => focusable.focus(), 30);
  }

  function closeModal(id) {
    const modal = $(id);
    if (!modal) return;
    modal.hidden = true;
    if (!all('.modal-overlay:not([hidden])').length) document.body.classList.remove('modal-open');
  }

  function installModalClose(id, closeId, cancelId) {
    const modal = $(id);
    $(closeId)?.addEventListener('click', () => closeModal(id));
    $(cancelId)?.addEventListener('click', () => closeModal(id));
    modal?.addEventListener('click', (event) => { if (event.target === modal) closeModal(id); });
  }

  function renderPlans(target = $('pricing-row'), options = {}) {
    if (!target) return;
    const plans = state.plans.length ? state.plans : fallbackPlans;
    target.innerHTML = plans.map((plan, index) => {
      const features = Array.isArray(plan.features) && plan.features.length ? plan.features : [`${plan.botSlots || 1} managed bot slot${plan.botSlots === 1 ? '' : 's'}`, 'Any Minecraft server', 'Unlimited targets', 'Live console'];
      const credits = Number(plan.monthlyCredits || plan.aiCredits || 0);
      const custom = Number(plan.priceUsd ?? plan.price ?? 0) === 0;
      return `<article class="plan ${plan.popular || index === 1 ? 'featured' : ''}">
        ${plan.popular || index === 1 ? '<span class="plan-badge">most popular</span>' : ''}
        <div class="plan-name">${escapeHtml(plan.name || plan.tier || plan.id)}</div>
        <div class="plan-tagline">${escapeHtml(plan.tagline || 'Managed Minecraft automation.')}</div>
        <div class="plan-price">${custom ? 'Custom' : `$${Number(plan.priceUsd ?? plan.price ?? 0).toFixed(0)}`} ${custom ? '' : '<span>/ month</span>'}</div>
        ${credits ? `<div class="plan-ltc per-bot">${credits.toLocaleString()} Beam AI credits included</div>` : '<div class="plan-ltc muted">Standard beam controls included</div>'}
        <ul>${features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join('')}</ul>
        ${custom ? '<a class="btn btn-ghost plan-btn" href="mailto:hello@abeam.lol">Talk to us</a>' : `<button class="btn ${plan.popular || index === 1 ? 'btn-primary' : 'btn-ghost'} plan-btn" data-buy-plan="${escapeHtml(plan.id)}">Get ${escapeHtml(plan.name || plan.id)}</button>`}
      </article>`;
    }).join('');
    all('[data-buy-plan]', target).forEach((button) => button.addEventListener('click', () => buyPlan(button.dataset.buyPlan)));
    if (options.dashboard) {
      target.closest('.change-plan')?.querySelector('.sub')?.remove();
    }
  }

  async function loadPlans() {
    try {
      const result = await api('/api/plans');
      state.plans = Array.isArray(result.plans) ? result.plans : fallbackPlans;
    } catch {
      state.plans = fallbackPlans;
    }
    renderPlans();
    renderPlans($('lic-plans'), { dashboard: true });
  }

  function setAuthMode(mode) {
    state.authMode = mode === 'signup' ? 'signup' : 'login';
    all('.auth-tab').forEach((button) => button.classList.toggle('active', button.dataset.mode === state.authMode));
    $('login-title').textContent = state.authMode === 'signup' ? 'Create an account' : 'Sign in';
    $('auth-submit').textContent = state.authMode === 'signup' ? '› create account' : '› sign in';
    $('auth-password').autocomplete = state.authMode === 'signup' ? 'new-password' : 'current-password';
    $('auth-err').hidden = true;
  }

  function openLogin(mode = 'login') {
    setAuthMode(mode);
    openModal('loginmodal');
  }

  function renderUser() {
    const user = state.user || {};
    const name = user.username || user.email || 'operator';
    $('nav-username').textContent = name;
    $('nav-username-side').textContent = name;
    $('user-sub').textContent = user.isGuest ? 'guest account' : (user.id || 'account');
    $('settings-email').textContent = user.email || state.account?.email || name;
    $('settings-provider').textContent = user.isGuest ? 'guest account' : 'authenticated account';
    $('user-avatar').textContent = (name[0] || '◉').toUpperCase();
    $('badge-admin').hidden = user.role !== 'admin';
    $('nav-guest').hidden = true;
    $('nav-authed').hidden = false;
    $('hero').hidden = true;
    $('features').hidden = true;
    $('how').hidden = true;
    $('faq').hidden = true;
    $('pricing').hidden = true;
    $('app').hidden = false;
    document.querySelector('main')?.classList.add('dashboard-main');
    const adminLink = document.querySelector('[data-panel="admin"]');
    const walletLink = document.querySelector('[data-panel="wallet"]');
    adminLink.hidden = user.role !== 'admin';
    walletLink.hidden = user.role !== 'admin';
  }

  function renderGuest() {
    $('nav-guest').hidden = false;
    $('nav-authed').hidden = true;
    ['hero', 'features', 'how', 'faq', 'pricing'].forEach((id) => { $(id).hidden = false; });
    $('app').hidden = true;
    document.querySelector('main')?.classList.remove('dashboard-main');
    state.user = null;
    state.account = null;
    window.clearInterval(state.botTimer);
  }

  async function checkAuth() {
    try {
      const result = await api('/api/me/web');
      if (result.user) {
        state.user = result.user;
        renderUser();
        await loadDashboard();
        startBotPolling();
      } else {
        renderGuest();
      }
    } catch {
      renderGuest();
    }
  }

  async function login(event) {
    event.preventDefault();
    const errorNode = $('auth-err');
    errorNode.hidden = true;
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    const endpoint = state.authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    const submit = $('auth-submit');
    submit.disabled = true;
    try {
      const result = await api(endpoint, { method: 'POST', body: { email, username: email, password } });
      state.user = result.user || { username: result.email || email, email: result.email || email };
      closeModal('loginmodal');
      renderUser();
      await loadDashboard();
      startBotPolling();
      toast(state.authMode === 'signup' ? 'Account created.' : 'Welcome back.');
    } catch (error) {
      errorNode.textContent = error.message;
      errorNode.hidden = false;
    } finally {
      submit.disabled = false;
    }
  }

  async function logout(event) {
    event?.preventDefault();
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    closeModal('loginmodal');
    renderGuest();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('Signed out.');
  }

  async function loadDashboard() {
    renderUser();
    await Promise.allSettled([loadAccount(), loadBots(), loadLicenses()]);
    if (state.user?.role === 'admin') await loadAdmin();
    renderSettings();
  }

  async function loadAccount() {
    try {
      const data = await api('/api/account');
      state.account = data;
      const sub = data.subscriber || {};
      const admin = data.isAdmin || state.user?.role === 'admin';
      $('stat-plan').textContent = admin ? 'Operator' : (sub.planName || 'Free');
      $('stat-slots').textContent = admin ? '∞' : String(sub.botSlots || 0);
      $('stat-targets').textContent = sub.targets === -1 || sub.targets === undefined ? '∞' : String(sub.targets || 0);
      $('credits-balance').textContent = sub.credits === undefined ? '—' : `${Number(sub.credits || 0).toLocaleString()} credits`;
      $('lic-plan').textContent = admin ? 'Operator' : (sub.planName || 'No license');
      $('lic-status').textContent = admin ? 'administrator access · unlimited managed capacity' : (sub.status === 'active' ? `active until ${formatDate(sub.expiresAt)}` : 'pick a plan to unlock your fleet');
      $('lic-badge').textContent = admin ? 'ADMIN' : (sub.planName || 'FREE').toUpperCase();
      $('lic-slots').textContent = admin ? '∞' : String(sub.botSlots || 0);
      $('lic-servers').textContent = admin ? '∞' : String(sub.servers?.length || sub.botSlots || 0);
      $('lic-targets').textContent = sub.targets === -1 || sub.targets === undefined ? '∞' : String(sub.targets || 0);
      $('lic-since').textContent = formatDate(sub.since);
      $('bot-lock').hidden = admin || !!sub.planId;
      if (data.user) state.user = { ...state.user, ...data.user };
      renderUser();
    } catch (error) {
      if (error.status === 401) return logout();
      console.warn('account load failed', error);
    }
  }

  async function loadBots(silent = false) {
    try {
      const data = await api('/api/bots');
      state.bots = Array.isArray(data.bots) ? data.bots : [];
      state.slots = Number(data.slots ?? 0);
      $('stat-slots').textContent = state.slots < 0 ? '∞' : String(state.slots);
      const servers = new Set(state.bots.map((bot) => `${bot.host}:${bot.port}`));
      $('stat-servers').textContent = String(servers.size);
      $('bot-lock').hidden = state.slots !== 0 || state.user?.role === 'admin';
      renderBots();
      if (state.activeBotId && !state.bots.some((bot) => bot.id === state.activeBotId)) closeConsole();
    } catch (error) {
      if (!silent) {
        if (error.status === 401) return logout();
        renderBots(error.message);
      }
    }
  }

  function botOnline(bot) {
    return ['online', 'connecting', 'joined'].includes(String(bot.status || '').toLowerCase());
  }

  function renderBots(errorMessage = '') {
    const list = $('bot-list');
    if (errorMessage) {
      list.innerHTML = `<li class="empty-state"><strong>Could not load the fleet</strong><span>${escapeHtml(errorMessage)}</span></li>`;
      return;
    }
    if (!state.bots.length) {
      list.innerHTML = `<li class="empty-state"><strong>No bots in this fleet yet.</strong><span>Create a slot, paste its Minecraft access token, and abeam will take care of the connection.</span><br><button class="btn btn-primary" data-empty-create>Create a bot</button></li>`;
      list.querySelector('[data-empty-create]')?.addEventListener('click', openCreateBot);
      return;
    }
    list.innerHTML = state.bots.map((bot, index) => {
      const online = botOnline(bot);
      const status = bot.status || 'offline';
      const username = bot.username || bot.minecraftUsername || 'Minecraft account pending';
      const rawUsername = bot.username || bot.minecraftUsername || '';
      const statusLabel = online ? (status === 'connecting' ? 'Connecting' : 'Joined') : (status === 'error' ? 'Failed' : 'Stopped');
      const statusClass = status === 'connecting' ? 'connecting' : online ? 'online' : 'offline';
      const avatar = online ? '⚔' : '◈';
      const avatarImage = rawUsername ? `<img class="mc-avatar-image" src="https://mc-heads.net/avatar/${encodeURIComponent(rawUsername)}/64" alt="" loading="lazy" onerror="this.style.display='none'">` : '';
      return `<li class="bot-card ${online ? 'on' : ''}" data-bot-id="${escapeHtml(bot.id)}">
        <div class="bot-left"><div class="mc-avatar" aria-hidden="true"><span class="avatar-fallback">${avatar}</span>${avatarImage}</div><div class="bot-meta">
          <div class="bot-title"><span>${escapeHtml(bot.name || `Bot ${index + 1}`)}</span><code>${escapeHtml(username)}</code><span class="bot-status-pill ${statusClass}"><i></i>${statusLabel}</span><span class="bot-engine">${escapeHtml((bot.engine || 'azalea').toUpperCase())}</span></div>
          <div class="bot-sub"><span>${escapeHtml(bot.host || 'server not set')}:${escapeHtml(bot.port || '25565')}</span>${bot.version && bot.version !== 'auto' ? `<span class="bot-chip">${escapeHtml(bot.version)}</span>` : '<span class="bot-chip">auto</span>'}${bot.proxyConfigured ? '<span class="bot-chip">proxy</span>' : ''}${bot.antiAfk ? '<span class="bot-chip">anti-AFK on</span>' : '<span class="bot-chip">anti-AFK off</span>'}${bot.beamLogging ? '<span class="bot-chip">logging</span>' : ''}${bot.aiRephrasing ? '<span class="bot-chip">beam ai</span>' : ''}</div>
        </div></div>
        <div class="bot-actions"><button class="btn btn-ghost" data-bot-action="console">Console</button><button class="btn btn-ghost" data-bot-action="inventory">Inventory</button><button class="btn btn-ghost" data-bot-action="afk">AFK ${bot.antiAfk ? 'on' : 'off'}</button><button class="btn ${online ? 'btn-ghost' : 'btn-primary'}" data-bot-action="${online ? 'stop' : 'start'}">${online ? 'Stop' : 'Start'}</button><button class="btn btn-ghost" data-bot-action="edit">Configure</button><button class="icon-btn" title="Delete bot" data-bot-action="delete">×</button></div>
      </li>`;
    }).join('');
  }

  function startBotPolling() {
    window.clearInterval(state.botTimer);
    state.botTimer = window.setInterval(() => { if (state.user) loadBots(true); }, 6000);
  }

  function showPanel(panel) {
    const allowed = ['bots', 'license', 'licenses', 'admin', 'wallet', 'settings'];
    if (!allowed.includes(panel)) panel = 'bots';
    state.activePanel = panel;
    all('.panel-page').forEach((section) => { section.hidden = section.id !== `panel-${panel}`; });
    all('[data-panel]').forEach((item) => item.classList.toggle('active', item.dataset.panel === panel));
    if (panel === 'licenses') loadLicenses();
    if (panel === 'admin' && state.user?.role === 'admin') loadAdmin();
    if (panel === 'wallet' && state.user?.role === 'admin') loadWallet();
    if (panel === 'settings') renderSettings();
    if (window.location.hash !== `#panel-${panel}`) history.replaceState(null, '', `#panel-${panel}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateBeamFields() {
    const type = $('slot-beam-type')?.value || 'ai';
    if ($('beam-ai-fields')) $('beam-ai-fields').hidden = type !== 'ai';
    if ($('beam-spam-fields')) $('beam-spam-fields').hidden = type === 'ai';
  }

  function openCreateBot() {
    state.editingBotId = null;
    $('slotmodal-title').textContent = 'Add a bot';
    $('slot-submit').textContent = 'Create & connect';
    $('slotmodal-form').reset();
    $('slot-port').value = '25565';
    $('slot-version').value = 'auto';
    $('slot-discord').value = 'stood014';
    $('slot-yt-channel').value = 'Alight.z';
    $('slot-beam-ip').value = 'badlion-pvp.xyz';
    $('slot-beam-type').value = 'ai';
    $('slot-opener').value = '';
    $('slot-spam-message').value = 'type 123 in chat for tier test all mode';
    $('slot-spam-interval').value = '60000';
    $('slot-trigger').value = '123';
    $('slot-reply').value = 'add my discord stood014 to join';
    updateBeamFields();
    $('slot-token').required = true;
    $('slot-token').placeholder = 'eyJraWQiOiJ…';
    $('slot-error').hidden = true;
    const azalea = document.querySelector('input[name="engine"][value="azalea"]');
    if (azalea) azalea.checked = true;
    openModal('slotmodal');
  }

  function openEditBot(bot) {
    state.editingBotId = bot.id;
    $('slotmodal-title').textContent = 'Configure bot';
    $('slot-submit').textContent = 'Save & reconnect';
    $('slot-name').value = bot.name || '';
    $('slot-server').value = bot.host || '';
    $('slot-port').value = bot.port || 25565;
    $('slot-version').value = bot.version || 'auto';
    $('slot-proxy').value = '';
    $('slot-token').value = '';
    $('slot-token').required = false;
    $('slot-token').placeholder = bot.hasToken ? 'Token saved · leave blank to keep it' : 'Paste a Minecraft access token';
    $('slot-username').value = bot.minecraftUsername || bot.username || '';
    $('slot-discord').value = bot.discordUser || '';
    $('slot-yt-channel').value = bot.ytChannel || 'Alight.z';
    $('slot-beam-ip').value = bot.beamIp || 'badlion-pvp.xyz';
    $('slot-beam-type').value = bot.beamType || 'ai';
    $('slot-opener').value = bot.openerScript || '';
    $('slot-spam-message').value = bot.spamMessage || 'type 123 in chat for tier test all mode';
    $('slot-spam-interval').value = String(bot.spamInterval || 60000);
    $('slot-trigger').value = bot.spamTriggerWord || '123';
    $('slot-reply').value = bot.spamReplyMessage || 'add my discord stood014 to join';
    updateBeamFields();
    $('slot-webhook').value = '';
    $('slot-ai').checked = bot.aiRephrasing !== false;
    $('slot-logging').checked = !!bot.beamLogging;
    const engine = document.querySelector(`input[name="engine"][value="${bot.engine === 'mineflayer' ? 'mineflayer' : 'azalea'}"]`);
    if (engine) engine.checked = true;
    $('slot-error').hidden = true;
    openModal('slotmodal');
  }

  async function saveBot(event) {
    event.preventDefault();
    const errorNode = $('slot-error');
    errorNode.hidden = true;
    const submit = $('slot-submit');
    const selectedEngine = document.querySelector('input[name="engine"]:checked')?.value || 'azalea';
    const token = $('slot-token').value.trim();
    const body = {
      name: $('slot-name').value.trim(),
      host: $('slot-server').value.trim(),
      port: Number($('slot-port').value) || 25565,
      version: $('slot-version').value || 'auto',
      proxy: state.editingBotId && !$('slot-proxy').value.trim() ? undefined : $('slot-proxy').value.trim(),
      discordUser: $('slot-discord').value.trim(),
      minecraftUsername: $('slot-username').value.trim(),
      ytChannel: $('slot-yt-channel').value.trim(),
      beamIp: $('slot-beam-ip').value.trim(),
      beamType: $('slot-beam-type').value || 'ai',
      openerScript: $('slot-opener').value.trim(),
      spamMessage: $('slot-spam-message').value.trim(),
      spamInterval: Number($('slot-spam-interval').value) || 60000,
      spamTriggerWord: $('slot-trigger').value.trim(),
      spamReplyMessage: $('slot-reply').value.trim(),
      engine: selectedEngine === 'nmp' ? 'azalea' : selectedEngine,
      aiRephrasing: $('slot-ai').checked,
      beamLogging: $('slot-logging').checked,
      discordWebhook: state.editingBotId && !$('slot-webhook').value.trim() ? undefined : $('slot-webhook').value.trim(),
      antiAfk: true,
    };
    if (token) body.token = token;
    if (!state.editingBotId && !token) {
      errorNode.textContent = 'A Minecraft access token is required for a new bot.';
      errorNode.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      const endpoint = state.editingBotId ? `/api/bots/${encodeURIComponent(state.editingBotId)}` : '/api/bots';
      await api(endpoint, { method: state.editingBotId ? 'PATCH' : 'POST', body });
      closeModal('slotmodal');
      await loadBots();
      toast(state.editingBotId ? 'Bot configuration saved.' : 'Bot created — connecting now.');
    } catch (error) {
      errorNode.textContent = error.message;
      errorNode.hidden = false;
    } finally {
      submit.disabled = false;
    }
  }

  function inventoryItem(item) {
    if (!item) return { name: '', count: 0 };
    return { name: item.name || item.displayName || item.type || '', count: Number(item.count || item.amount || 0) };
  }

  function inventoryGlyph(name) {
    const value = String(name || '').toLowerCase();
    if (value.includes('sword')) return '⚔';
    if (value.includes('pickaxe') || value.includes('axe') || value.includes('shovel')) return '⛏';
    if (value.includes('bow') || value.includes('crossbow')) return '⌁';
    if (value.includes('diamond')) return '◆';
    if (value.includes('iron')) return '⬢';
    if (value.includes('gold')) return '✦';
    if (value.includes('apple') || value.includes('food') || value.includes('bread')) return '●';
    if (value.includes('totem')) return '✧';
    return '✹';
  }

  function renderInventory(data, bot) {
    const snapshot = data?.snapshot || data || {};
    const hotbar = Array.isArray(snapshot.hotbar) ? snapshot.hotbar : [];
    const status = snapshot.available === false
      ? 'Inventory is available when the bot is online.'
      : `Health ${Number(snapshot.health ?? 20).toFixed(0)} · Food ${Number(snapshot.food ?? 20).toFixed(0)} · ${escapeHtml(snapshot.dimension || 'world')}`;
    $('inventory-status').textContent = `${bot?.name || 'Bot'} · ${status}`;
    const renderSlots = (items, kind) => {
      const count = kind === 'hotbar' ? 9 : Math.max(9, Math.ceil(items.length / 9) * 9);
      return Array.from({ length: count }, (_, index) => {
        const item = inventoryItem(items[index]);
        const filled = !!item.name;
        return `<button class="inv-slot ${filled ? 'filled' : ''}" data-inventory-kind="${kind}" data-inventory-slot="${index}" title="${escapeHtml(item.name || 'Empty slot')}">${filled ? `<span class="inv-glyph">${inventoryGlyph(item.name)}</span><span class="inv-name">${escapeHtml(item.name.replace(/^minecraft:/, '').replaceAll('_', ' ').slice(0, 12))}</span>` : '<span class="inv-empty">·</span>'}${filled && item.count ? `<span class="inv-count">×${item.count}</span>` : ''}</button>`;
      }).join('');
    };
    $('inventory-grid').innerHTML = renderSlots(hotbar, 'hotbar');
    const windowSlots = Array.isArray(snapshot.window?.slots) ? snapshot.window.slots : [];
    $('inventory-window').hidden = !windowSlots.length;
    $('inventory-window-grid').innerHTML = windowSlots.length ? renderSlots(windowSlots, 'window') : '';
  }

  async function loadInventory(id) {
    try {
      const data = await api(`/api/bots/${encodeURIComponent(id)}/view`);
      renderInventory(data, state.bots.find((item) => item.id === id));
    } catch (error) {
      $('inventory-status').textContent = error.message;
      $('inventory-grid').innerHTML = '<div class="console-placeholder">Could not read the live inventory.</div>';
    }
  }

  async function openInventory(id) {
    state.activeBotId = id;
    const bot = state.bots.find((item) => item.id === id);
    $('inventory-title').textContent = `${bot?.name || 'Bot'} inventory`;
    $('inventory-grid').innerHTML = '<div class="console-placeholder">Loading live inventory…</div>';
    openModal('inventorymodal');
    await loadInventory(id);
  }

  async function inventoryAction(kind, slot) {
    if (!state.activeBotId) return;
    try {
      const action = kind === 'window' ? 'clickWindow' : 'select';
      await api(`/api/bots/${encodeURIComponent(state.activeBotId)}/action`, { method: 'POST', body: { action, slot: Number(slot) } });
      await loadInventory(state.activeBotId);
    } catch (error) { toast(error.message); }
  }

  async function toggleAntiAfk(id) {
    const bot = state.bots.find((item) => item.id === id);
    if (!bot) return;
    try {
      await api(`/api/bots/${encodeURIComponent(id)}`, { method: 'PATCH', body: { antiAfk: !bot.antiAfk } });
      await loadBots();
      toast(`Anti-AFK ${bot.antiAfk ? 'disabled' : 'enabled'}.`);
    } catch (error) { toast(error.message); }
  }

  async function botAction(id, action) {
    const bot = state.bots.find((item) => item.id === id);
    if (!bot) return;
    if (action === 'console') return openConsole(id);
    if (action === 'inventory') {
      openBotDetail(id);
      setDetailTab('screen');
      return;
    }
    if (action === 'afk') return toggleAntiAfk(id);
    if (action === 'edit') return openEditBot(bot);
    if (action === 'delete') {
      if (!window.confirm(`Delete ${bot.name || 'this bot'}? Its saved credentials will be removed.`)) return;
      try { await api(`/api/bots/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadBots(); toast('Bot deleted.'); } catch (error) { toast(error.message); }
      return;
    }
    const endpoint = action === 'start' ? 'start' : 'stop';
    try {
      await api(`/api/bots/${encodeURIComponent(id)}/${endpoint}`, { method: 'POST' });
      await loadBots();
      toast(action === 'start' ? 'Bot is connecting.' : 'Bot stopped.');
    } catch (error) { toast(error.message); }
  }

  function setFleetView(detail) {
    const panel = $('panel-bots');
    panel?.querySelector(':scope > .panel-head')?.toggleAttribute('hidden', detail);
    panel?.querySelector(':scope > .fleet-actions')?.toggleAttribute('hidden', detail);
    panel?.querySelector(':scope > .stat-row')?.toggleAttribute('hidden', detail);
    if ($('bot-lock')) $('bot-lock').hidden = detail || state.slots !== 0 || state.user?.role === 'admin';
    $('bot-list').hidden = detail;
  }

  function renderDetailHeader(bot) {
    if (!bot) return;
    const online = botOnline(bot);
    const status = bot.status || 'offline';
    const statusLabel = online ? (status === 'connecting' ? 'Connecting' : 'Joined') : (status === 'error' ? 'Failed' : 'Stopped');
    const statusClass = status === 'connecting' ? 'connecting' : online ? 'online' : 'offline';
    const rawUsername = bot.username || bot.minecraftUsername || '';
    $('detail-name').textContent = bot.name || 'Bot';
    $('detail-meta').textContent = `${bot.host || 'server'}:${bot.port || 25565} · ${rawUsername || 'Minecraft account pending'} · ${(bot.engine || 'azalea').toUpperCase()}`;
    const statusNode = $('detail-status');
    statusNode.className = `bot-status-pill ${statusClass}`;
    statusNode.innerHTML = `<i></i>${statusLabel}`;
    $('detail-avatar').innerHTML = rawUsername
      ? `<span class="avatar-fallback">⚔</span><img class="mc-avatar-image" src="https://mc-heads.net/avatar/${encodeURIComponent(rawUsername)}/64" alt="" loading="lazy" onerror="this.style.display='none'">`
      : '<span class="avatar-fallback">⚔</span>';
    $('detail-toggle').textContent = online ? 'Stop bot' : 'Start bot';
    $('detail-toggle').classList.toggle('btn-primary', !online);
    $('detail-toggle').classList.toggle('btn-ghost', online);
    $('console-title').textContent = `${bot.name || 'bot'} console`;
    $('console-tabs').innerHTML = `<button class="console-tab active">${escapeHtml(bot.name || 'bot')}</button>`;
  }

  function setDetailTab(tab) {
    state.detailTab = tab === 'screen' ? 'screen' : 'console';
    all('[data-detail-tab]').forEach((button) => button.classList.toggle('active', button.dataset.detailTab === state.detailTab));
    $('detail-console-panel').hidden = state.detailTab !== 'console';
    $('detail-screen-panel').hidden = state.detailTab !== 'screen';
    if (state.detailTab === 'screen') loadView(state.activeBotId);
    else loadConsole(state.activeBotId);
  }

  function closeConsole() {
    window.clearInterval(state.detailTimer);
    state.detailTimer = null;
    state.activeBotId = null;
    state.detailView = null;
    $('console-wrap').hidden = true;
    $('console-panes').innerHTML = '';
    $('console-tabs').innerHTML = '';
    setFleetView(false);
  }

  function openBotDetail(id) {
    const bot = state.bots.find((item) => item.id === id);
    if (!bot) return;
    state.activeBotId = id;
    state.detailTab = 'console';
    setFleetView(true);
    $('console-wrap').hidden = false;
    renderDetailHeader(bot);
    setDetailTab('console');
    window.clearInterval(state.detailTimer);
    state.detailTimer = window.setInterval(() => {
      if (!state.activeBotId) return;
      renderDetailHeader(state.bots.find((item) => item.id === state.activeBotId));
      if (state.detailTab === 'screen') loadView(state.activeBotId);
      else loadConsole(state.activeBotId);
    }, state.detailTab === 'screen' ? 800 : 1500);
    $('console-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function openConsole(id) {
    openBotDetail(id);
  }

  function usefulConsoleLine(entry, bot) {
    const raw = typeof entry === 'string' ? entry : (entry?.line || entry?.message || '');
    const line = String(raw);
    const lower = line.toLowerCase();
    if (!line.trim()) return false;
    if (line.includes('§')) return false;
    if (['more than 1,000 items', 'packet-event', 'error reading packet', 'explode (id 36)', 'failed to fill whole buffer', 'packet explode', 'azalea_client::plugins::connection'].some((part) => lower.includes(part))) return false;
    if (/\b(joined|left)\b/.test(lower) && !/(azalea|spawned|logged in|disconnected|connected)/.test(lower)) return false;
    if (bot?.username && lower.includes(`${String(bot.username).toLowerCase()} joined`) && !lower.includes('azalea')) return false;
    return true;
  }

  async function loadConsole(id) {
    if (!id || state.activeBotId !== id) return;
    try {
      const data = await api(`/api/bots/${encodeURIComponent(id)}/console`);
      const bot = state.bots.find((item) => item.id === id);
      const logs = (Array.isArray(data.logs) ? data.logs : []).filter((entry) => usefulConsoleLine(entry, bot));
      $('console-panes').innerHTML = logs.length ? logs.map((entry) => {
        const line = cleanConsoleLine(typeof entry === 'string' ? entry : (entry.line || entry.message || ''));
        const level = typeof entry === 'object' ? (entry.level || 'system') : 'system';
        const speakerClass = level === 'error' ? 'target' : level === 'chat' ? 'bot' : 'system';
        return `<div class="console-line"><span class="time">${escapeHtml(formatTime(entry.ts || entry.time))}</span><span class="who-${speakerClass}">${escapeHtml(level)}</span>${escapeHtml(line)}</div>`;
      }).join('') : '<div class="console-placeholder">No console lines yet. Start the bot to see its Azalea connection log.</div>';
      const body = $('console-panes');
      if (body) body.scrollTop = body.scrollHeight;
    } catch (error) {
      $('console-panes').innerHTML = `<div class="console-placeholder">${escapeHtml(error.message)}</div>`;
    }
  }

  function renderGameView(data, bot) {
    const snapshot = data?.snapshot || { available: false };
    const available = snapshot.available !== false;
    $('game-view-empty').hidden = available;
    $('game-view-online').hidden = !available;
    if (!available) return;

    const health = Math.max(0, Math.min(20, Number(snapshot.health ?? 20)));
    const food = Math.max(0, Math.min(20, Number(snapshot.food ?? 20)));
    $('game-health').textContent = `${health.toFixed(0)} / 20`;
    $('game-food').textContent = `${food.toFixed(0)} / 20`;
    $('health-meter').style.width = `${health * 5}%`;
    $('food-meter').style.width = `${food * 5}%`;
    $('game-held').textContent = snapshot.heldItem || 'Empty';
    $('game-facing').textContent = snapshot.facing || 'N';
    const position = snapshot.position || {};
    $('game-location').textContent = `${Number(position.x || 0).toFixed(1)}, ${Number(position.y || 0).toFixed(1)}, ${Number(position.z || 0).toFixed(1)} · ${snapshot.dimension || 'overworld'}`;

    const entities = Array.isArray(snapshot.entities) ? snapshot.entities : [];
    $('game-entity-count').textContent = String(entities.length);
    $('nearby-entities').innerHTML = entities.length ? entities.map((entity) => {
      const kind = entity.kind === 'mob' ? 'mob' : 'player';
      const name = entity.name || entity.displayName || kind;
      const distance = entity.distance ?? (entity.position ? Math.round(Math.hypot(Number(entity.position.x || 0), Number(entity.position.z || 0))) : '—');
      return `<div class="nearby-row ${kind}"><span><b></b><strong>${escapeHtml(name)}</strong></span><em>${escapeHtml(distance)}m</em></div>`;
    }).join('') : '<span class="game-muted">No nearby entities.</span>';

    const radar = $('radar-entities');
    radar.innerHTML = entities.map((entity) => {
      const dx = Number(entity.right ?? entity.position?.x ?? 0);
      const dz = Number(entity.forward ?? entity.position?.z ?? 0);
      const left = Math.max(5, Math.min(95, 50 + dx / 32 * 45));
      const top = Math.max(5, Math.min(95, 50 - dz / 32 * 45));
      const kind = entity.kind === 'mob' ? 'mob' : entity.kind === 'object' ? 'object' : 'player';
      return `<span class="radar-dot ${kind}" style="left:${left}%;top:${top}%" title="${escapeHtml(entity.name || kind)}"></span>`;
    }).join('');

    const hotbar = Array.isArray(snapshot.hotbar) ? snapshot.hotbar : [];
    $('detail-hotbar').innerHTML = Array.from({ length: 9 }, (_, index) => {
      const item = inventoryItem(hotbar[index]);
      const filled = !!item.name;
      const selected = hotbar[index]?.selected === true || Number(snapshot.selectedSlot) === index;
      return `<button class="inv-slot ${filled ? 'filled' : ''} ${selected ? 'selected' : ''}" data-detail-hotbar-slot="${index}" title="${escapeHtml(item.name || 'Empty slot')}"><span class="slot-number">${index + 1}</span>${filled ? `<span class="inv-glyph">${inventoryGlyph(item.name)}</span><span class="inv-name">${escapeHtml(item.name.replace(/^minecraft:/, '').replaceAll('_', ' ').slice(0, 12))}</span>${item.count > 1 ? `<span class="inv-count">×${item.count}</span>` : ''}` : '<span class="inv-empty">·</span>'}</button>`;
    }).join('');

    const openWindow = snapshot.window && Array.isArray(snapshot.window.slots);
    $('detail-gui').hidden = !openWindow;
    if (openWindow) {
      $('detail-gui-title').textContent = snapshot.window.title || 'Open container';
      $('detail-gui-grid').innerHTML = snapshot.window.slots.map((entry, index) => {
        const item = inventoryItem(entry);
        const filled = !!item.name;
        const slot = Number(entry?.slot ?? index);
        return `<button class="inv-slot ${filled ? 'filled' : ''}" data-detail-gui-slot="${slot}" title="${escapeHtml(item.name || 'Empty slot')}">${filled ? `<span class="inv-glyph">${inventoryGlyph(item.name)}</span><span class="inv-name">${escapeHtml(item.name.replace(/^minecraft:/, '').replaceAll('_', ' ').slice(0, 12))}</span>${item.count > 1 ? `<span class="inv-count">×${item.count}</span>` : ''}` : '<span class="inv-empty">·</span>'}</button>`;
      }).join('');
    }
    $('hotbar-hint').textContent = `${bot?.name || 'Bot'} · click to select · use to open a GUI`;
  }

  async function loadView(id) {
    if (!id || state.activeBotId !== id) return;
    try {
      const data = await api(`/api/bots/${encodeURIComponent(id)}/view`);
      state.detailView = data;
      renderGameView(data, state.bots.find((item) => item.id === id));
    } catch (error) {
      $('game-view-empty').hidden = false;
      $('game-view-online').hidden = true;
      $('game-empty-icon').textContent = '×';
    }
  }

  async function detailAction(action, payload = {}) {
    if (!state.activeBotId) return;
    try {
      await api(`/api/bots/${encodeURIComponent(state.activeBotId)}/action`, { method: 'POST', body: { action, ...payload } });
      await loadView(state.activeBotId);
    } catch (error) { toast(error.message); }
  }

  async function toggleDetailBot() {
    const bot = state.bots.find((item) => item.id === state.activeBotId);
    if (!bot) return;
    const action = botOnline(bot) ? 'stop' : 'start';
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}/${action}`, { method: 'POST' });
      await loadBots(true);
      renderDetailHeader(state.bots.find((item) => item.id === bot.id));
      if (state.detailTab === 'screen') await loadView(bot.id);
    } catch (error) { toast(error.message); }
  }

  async function sendConsoleMessage(event) {
    event.preventDefault();
    const input = $('console-message');
    const message = input.value.trim();
    if (!state.activeBotId || !message) return;
    try {
      await api(`/api/bots/${encodeURIComponent(state.activeBotId)}/console`, { method: 'POST', body: { message } });
      input.value = '';
      await loadConsole(state.activeBotId);
    } catch (error) { toast(error.message); }
  }

  async function sendQuickConsoleMessage(message) {
    if (!state.activeBotId || !message) return;
    try {
      await api(`/api/bots/${encodeURIComponent(state.activeBotId)}/console`, { method: 'POST', body: { message } });
      await loadConsole(state.activeBotId);
    } catch (error) { toast(error.message); }
  }

  async function allBots(action) {
    const rows = [...state.bots];
    for (const bot of rows) {
      try { await api(`/api/bots/${encodeURIComponent(bot.id)}/${action}`, { method: 'POST' }); } catch {}
    }
    await loadBots();
    toast(action === 'start' ? 'Starting all bots.' : 'Stopping all bots.');
  }

  async function loadLicenses() {
    try {
      const data = await api('/api/licenses');
      const current = data.current;
      if (current) {
        $('lic-plan').textContent = current.planName || current.planId || 'Active';
        $('lic-badge').textContent = String(current.planName || current.planId || 'active').toUpperCase();
      }
      const active = data.activeLicenses || [];
      const expired = data.expiredLicenses || [];
      const invoices = data.invoices || [];
      const rows = [...active.map((license) => ({ ...license, type: 'active', label: license.reason || 'Redeemed license' })), ...expired.map((license) => ({ ...license, type: 'expired', label: license.reason || 'Previous license' })), ...invoices.map((invoice) => ({ ...invoice, type: invoice.status, label: invoice.planName || invoice.planId || 'Invoice' }))];
      $('licenses-list').innerHTML = rows.length ? rows.map((row) => `<div class="license-row"><div><div class="lic-plan-name">${escapeHtml(row.label)}</div><div class="lic-meta">${escapeHtml(row.licenseKey || row.id || '')} · ${escapeHtml(row.timeLeft || row.status || '')}</div></div><span class="pill ${row.type === 'active' || row.status === 'paid' ? 'paid' : 'pending'}">${escapeHtml(row.type === 'active' ? 'active' : row.status || row.type)}</span></div>`).join('') : '<div class="empty-state"><strong>No license history yet.</strong><span>Buy a plan or redeem a key to get started.</span></div>';
    } catch (error) {
      $('licenses-list').innerHTML = `<div class="empty-state"><strong>Billing is unavailable</strong><span>${escapeHtml(error.message)}</span></div>`;
    }
  }

  async function redeemLicense() {
    const input = $('redeem-input');
    const message = $('redeem-msg');
    const code = input.value.trim();
    if (!code) return;
    try {
      const data = await api('/api/licenses/redeem', { method: 'POST', body: { code } });
      message.className = 'hint';
      message.textContent = `Redeemed ${data.planId || 'license'} successfully.`;
      input.value = '';
      await loadDashboard();
      toast('License redeemed.');
    } catch (error) {
      message.className = 'hint';
      message.textContent = error.message;
    }
  }

  async function loadAdmin() {
    try {
      const [wallet, users] = await Promise.all([api('/api/admin/wallet'), api('/api/admin/users')]);
      $('admin-revenue').textContent = `$${Number(wallet.revenueUsd || 0).toFixed(2)}`;
      $('admin-users-count').textContent = String(users.total ?? users.users?.length ?? 0);
      $('admin-bots-count').textContent = String((users.users || []).reduce((sum, user) => sum + Number(user.botCount || 0), 0));
      $('admin-users').innerHTML = (users.users || []).length ? users.users.map((user) => `<div class="admin-list-row"><span><b>${escapeHtml(user.username || user.email || user.id)}</b><br><small>${escapeHtml(user.planName || 'no plan')} · ${Number(user.botCount || 0)} bots</small></span><small>${escapeHtml(user.role || 'user')}</small></div>`).join('') : '<div class="muted">No users yet.</div>';
    } catch (error) {
      $('admin-revenue').textContent = 'unavailable';
      $('admin-users').innerHTML = `<div class="muted">${escapeHtml(error.message)}</div>`;
    }
  }

  async function generateLicense() {
    const output = $('admin-key-output');
    try {
      const plan = $('admin-plan').value;
      const months = Number($('admin-months').value);
      const planData = state.plans.find((item) => item.id === plan) || fallbackPlans.find((item) => item.id === plan);
      const slots = Number(planData?.botSlots || 1);
      const result = await api('/api/admin/licenses', { method: 'POST', body: { slots, durationDays: months * 30, durationHours: 0, reason: 'admin generated' } });
      output.textContent = result.key || result.licenseKey?.key || 'Generated';
      output.hidden = false;
      toast('License key generated.');
    } catch (error) { toast(error.message); }
  }

  async function loadWallet() {
    try {
      const [wallet, address, txs] = await Promise.all([api('/api/owner/wallet'), api('/api/owner/wallet/address'), api('/api/owner/wallet/txs')]);
      $('wallet-balance').textContent = `${Number(wallet.balanceUsd || wallet.balance || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' })}`;
      $('wallet-address').textContent = address.address || 'not configured';
      $('wallet-txs').innerHTML = (txs.txs || []).length ? txs.txs.map((tx) => `<div class="admin-list-row"><span>${escapeHtml(tx.type || 'transaction')}</span><small>${escapeHtml(tx.txid || tx.hash || 'pending')}</small></div>`).join('') : '<div class="muted">No wallet transactions recorded.</div>';
    } catch (error) {
      $('wallet-balance').textContent = 'not configured';
      $('wallet-address').textContent = error.message;
      $('wallet-txs').innerHTML = '<div class="muted">Wallet data is only available to the owner with LTC_SEED configured.</div>';
    }
  }

  function renderSettings() {
    const ssid = state.account?.subscriber?.ssid || state.account?.subscriber?.ssids?.[0];
    $('ssid-display').textContent = ssid ? String(ssid).slice(0, 5) + '••••••' : 'Managed by session';
    const saved = localStorage.getItem('abeam-theme') || 'green';
    document.documentElement.dataset.theme = saved;
    all('.theme-swatch').forEach((button) => button.classList.toggle('active', button.dataset.theme === saved));
  }

  async function buyPlan(planId) {
    if (!state.user) return openLogin('signup');
    const plan = state.plans.find((item) => item.id === planId) || fallbackPlans.find((item) => item.id === planId);
    if (!plan) return;
    try {
      const result = await api(`/api/plans/${encodeURIComponent(planId)}/invoice`, { method: 'POST', body: {} });
      const invoice = result.invoice || result;
      state.invoice = invoice;
      $('checkout-plan').textContent = plan.name || planId;
      $('checkout-usd').textContent = `$${Number(invoice.amountUsd ?? invoice.amountUSD ?? plan.priceUsd ?? 0).toFixed(2)}`;
      $('checkout-ltc').textContent = `${invoice.amountLtc ?? invoice.amountLTC ?? '—'} LTC`;
      $('checkout-ltc-amount').textContent = invoice.amountLtc ?? invoice.amountLTC ?? '—';
      $('checkout-address').textContent = invoice.address || invoice.ltcAddress || '—';
      $('checkout-qr-img').src = invoice.qr || invoice.qrDataUrl || '';
      $('checkout-status').classList.remove('paid');
      $('checkout-status-text').textContent = 'Waiting for payment…';
      openModal('checkout');
      startInvoicePolling(invoice.id, invoice.created || Date.now());
    } catch (error) { toast(error.message); }
  }

  async function buyCredits() {
    const raw = window.prompt('How many Beam AI credits would you like to buy?', '1000');
    const credits = Math.floor(Number(raw));
    if (!Number.isFinite(credits) || credits <= 0) return;
    try {
      const result = await api('/api/credits/buy', { method: 'POST', body: { credits } });
      const invoice = result.invoice || result;
      state.invoice = invoice;
      $('checkout-plan').textContent = `${credits.toLocaleString()} Beam AI credits`;
      $('checkout-usd').textContent = `$${Number(invoice.amountUsd ?? invoice.amountUSD ?? 0).toFixed(2)}`;
      $('checkout-ltc').textContent = `${invoice.amountLtc ?? invoice.amountLTC ?? '—'} LTC`;
      $('checkout-ltc-amount').textContent = invoice.amountLtc ?? invoice.amountLTC ?? '—';
      $('checkout-address').textContent = invoice.address || invoice.ltcAddress || '—';
      $('checkout-qr-img').src = invoice.qr || invoice.qrDataUrl || '';
      $('checkout-status').classList.remove('paid');
      $('checkout-status-text').textContent = 'Waiting for payment…';
      openModal('checkout');
      startInvoicePolling(invoice.id, invoice.created || Date.now());
    } catch (error) { toast(error.message); }
  }

  function startInvoicePolling(id, created) {
    window.clearInterval(state.invoiceTimer);
    window.clearInterval(state.invoiceCountdown);
    const deadline = new Date(created || Date.now()).getTime() + 30 * 60 * 1000;
    const tick = () => {
      const left = Math.max(0, deadline - Date.now());
      const seconds = Math.floor(left / 1000);
      $('checkout-timer').textContent = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
      if (!left) window.clearInterval(state.invoiceCountdown);
    };
    tick();
    state.invoiceCountdown = window.setInterval(tick, 1000);
    state.invoiceTimer = window.setInterval(() => checkInvoice(false), 12000);
  }

  async function checkInvoice(manual = true) {
    if (!state.invoice?.id) return;
    try {
      const result = await api(`/api/invoices/${encodeURIComponent(state.invoice.id)}`);
      const invoice = result.invoice || result;
      state.invoice = { ...state.invoice, ...invoice };
      if (invoice.qr) $('checkout-qr-img').src = invoice.qr;
      if (invoice.status === 'paid') {
        window.clearInterval(state.invoiceTimer);
        $('checkout-status').classList.add('paid');
        $('checkout-status-text').textContent = 'Payment confirmed — your license is active.';
        toast('Payment confirmed.');
        await loadDashboard();
      } else if (manual) {
        toast('No confirmed payment yet.');
      }
    } catch (error) { if (manual) toast(error.message); }
  }

  async function cancelInvoice() {
    if (!state.invoice?.id) return closeModal('checkout');
    try { await api(`/api/invoices/${encodeURIComponent(state.invoice.id)}`, { method: 'DELETE' }); } catch {}
    window.clearInterval(state.invoiceTimer);
    window.clearInterval(state.invoiceCountdown);
    state.invoice = null;
    closeModal('checkout');
  }

  async function copyText(value) {
    try { await navigator.clipboard.writeText(value); toast('Copied.'); } catch { toast('Copy unavailable in this browser.'); }
  }

  function bindEvents() {
    $('btn-login')?.addEventListener('click', (event) => { event.preventDefault(); openLogin('login'); });
    $('btn-hero-login')?.addEventListener('click', (event) => { event.preventDefault(); openLogin('signup'); });
    $('btn-logout')?.addEventListener('click', logout);
    $('btn-logout-side')?.addEventListener('click', logout);
    $('auth-form')?.addEventListener('submit', login);
    $('login-discord')?.addEventListener('click', () => { window.location.href = '/api/auth/discord/login'; });
    all('.auth-tab').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.mode)));
    installModalClose('loginmodal', 'login-close');
    installModalClose('checkout', 'checkout-close', 'checkout-cancel');
    installModalClose('slotmodal', 'slotmodal-close', 'slotmodal-cancel');
    installModalClose('inventorymodal', 'inventory-close', 'inventory-done');
    $('slotmodal-form')?.addEventListener('submit', saveBot);
    $('slot-beam-type')?.addEventListener('change', updateBeamFields);
    $('btn-create-bot')?.addEventListener('click', openCreateBot);
    $('btn-start-all')?.addEventListener('click', () => allBots('start'));
    $('btn-stop-all')?.addEventListener('click', () => allBots('stop'));
    $('console-close')?.addEventListener('click', closeConsole);
    $('detail-back')?.addEventListener('click', closeConsole);
    $('detail-configure')?.addEventListener('click', () => {
      const bot = state.bots.find((item) => item.id === state.activeBotId);
      if (bot) openEditBot(bot);
    });
    $('detail-toggle')?.addEventListener('click', toggleDetailBot);
    all('[data-detail-tab]').forEach((button) => button.addEventListener('click', () => setDetailTab(button.dataset.detailTab)));
    $('detail-use')?.addEventListener('click', () => detailAction('use'));
    $('detail-drop')?.addEventListener('click', () => detailAction('drop'));
    $('detail-refresh-view')?.addEventListener('click', () => loadView(state.activeBotId));
    $('detail-gui-close')?.addEventListener('click', () => detailAction('closeWindow'));
    all('[data-detail-move]').forEach((button) => button.addEventListener('click', () => detailAction('move', { dir: button.dataset.detailMove })));
    $('detail-hotbar')?.addEventListener('click', (event) => { const slot = event.target.closest('[data-detail-hotbar-slot]'); if (slot) detailAction('select', { slot: Number(slot.dataset.detailHotbarSlot) }); });
    $('detail-gui-grid')?.addEventListener('click', (event) => { const slot = event.target.closest('[data-detail-gui-slot]'); if (slot) detailAction('clickWindow', { slot: Number(slot.dataset.detailGuiSlot) }); });
    $('console-form')?.addEventListener('submit', sendConsoleMessage);
    all('[data-console-quick]').forEach((button) => button.addEventListener('click', () => sendQuickConsoleMessage(button.dataset.consoleQuick)));
    $('inventory-refresh')?.addEventListener('click', () => state.activeBotId && loadInventory(state.activeBotId));
    all('#inventory-grid, #inventory-window-grid').forEach((grid) => grid.addEventListener('click', (event) => { const slot = event.target.closest('[data-inventory-slot]'); if (slot) inventoryAction(slot.dataset.inventoryKind, slot.dataset.inventorySlot); }));
    $('btn-redeem')?.addEventListener('click', redeemLicense);
    $('redeem-input')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); redeemLicense(); } });
    $('admin-generate')?.addEventListener('click', generateLicense);
    $('btn-buy-credits')?.addEventListener('click', buyCredits);
    $('wallet-refresh')?.addEventListener('click', loadWallet);
    $('btn-copy')?.addEventListener('click', () => copyText(state.account?.subscriber?.ssid || 'Managed by session'));
    $('checkout-check')?.addEventListener('click', () => checkInvoice(true));
    $('checkout-cancel')?.addEventListener('click', cancelInvoice);
    $('checkout-copy-ltc')?.addEventListener('click', () => copyText($('checkout-ltc-amount').textContent));
    $('checkout-copy-addr')?.addEventListener('click', () => copyText($('checkout-address').textContent));
    all('[data-panel]').forEach((item) => item.addEventListener('click', (event) => { event.preventDefault(); showPanel(item.dataset.panel); }));
    all('[data-scroll]').forEach((item) => item.addEventListener('click', (event) => { if (!state.user) { event.preventDefault(); document.querySelector(item.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' }); } }));
    $('bot-list')?.addEventListener('click', (event) => {
      const actionButton = event.target.closest('[data-bot-action]');
      if (actionButton) { event.preventDefault(); botAction(actionButton.closest('[data-bot-id]')?.dataset.botId, actionButton.dataset.botAction); }
    });
    all('.theme-swatch').forEach((button) => button.addEventListener('click', () => { const theme = button.dataset.theme; document.documentElement.dataset.theme = theme; localStorage.setItem('abeam-theme', theme); renderSettings(); }));
    $('motion-toggle')?.addEventListener('change', (event) => document.body.classList.toggle('reduced-motion', event.target.checked));
    $('sound-toggle')?.addEventListener('change', () => {});
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') all('.modal-overlay:not([hidden])').forEach((modal) => closeModal(modal.id)); });
  }

  async function init() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('error')) showError(params.get('error').replaceAll('_', ' '));
    bindEvents();
    await loadPlans();
    await checkAuth();
    const hash = window.location.hash.replace('#panel-', '');
    if (state.user && ['bots', 'license', 'licenses', 'admin', 'wallet', 'settings'].includes(hash)) showPanel(hash);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
