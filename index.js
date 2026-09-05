import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { config } from './config.js';
import {
  createToken,
  validateToken,
  tokenFromHeader,
  upsertStaticToken,
} from './auth/ssid.js';
import {
  createSession,
  destroySession,
  getSessionUser,
} from './auth/web-session.js';
import { createBotBridge } from './bot-bridge.js';
import { paidPlans, planById } from './plans.js';
import { checkLogin, getPasswordUser, setPasswordUser, normalizeEmail } from './auth/password.js';
import {
  createInvoice,
  getInvoice,
  markPaid,
  checkAddress,
  startWatcher,
  cancelStaleInvoices,
} from './billing/invoices.js';
import { qrDataUrl, EXPLORER_BASE } from './billing/ltc.js';
import {
  grantSubscription,
  getSubscriber,
  setTargetServers,
  ensureDemoAccount,
  ensureLocalTrial,
  accountForBearer,
  getSlotConfig,
  setSlotConfig,
  patchSubscriber,
  resolveAccountKey,
  expireLapsedSubscribers,
  isActiveSubscriber,
} from './billing/subscribers.js';
import { creditBalance, grantCreditTopup } from './billing/credits.js';
import { generateLicenseKey, redeemLicenseKey, listLicenseKeys, clampMonths } from './billing/licenses.js';
import { pingServer, pingServers } from './mcping.js';
import { logDevlog } from './webhook/index.js';
import { BotSupervisor } from './bots/supervisor.js';
import { store } from './store/index.js';
import { validateMinecraftToken } from './auth/minecraft-token.js';
import { isAdminUser } from './admin-check.js';
import { getWalletData, sweepAll, sendFromWallet, ownerAddress, startOwnerSweeper, fetchLtcPrice } from './wallet/owner-wallet.js';
import {
  listBots,
  countBots,
  getBot,
  createBot as createManagedBot,
  updateBot as updateManagedBot,
  deleteBot as deleteManagedBot,
  enableBot,
  disableBot,
  sendChat,
  getLogs,
  getRuntimeView,
  getViewSnapshot,
  getBeamState,
  startBeam,
  stopBeam,
  selectHotbarSlot,
  useHeldItem,
  dropHeldItem,
  moveBot,
  clickWindowSlot,
  closeWindow,
  resumeEnabledBots,
} from './bots/manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const app = express();
const server = http.createServer(app);

function isAdmin(user) {
  return isAdminUser(user);
}

app.use(cors({ origin: config.appUrl, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(PUBLIC_DIR));
app.set('trust proxy', 1);

// The original abeam landing page and operator dashboard are served by the
// same Express process as the API. `/dashboard` remains a convenient alias.
app.get(['/', '/dashboard', '/dashboard/'], (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Railway and uptime monitors use this endpoint; it intentionally does not
// touch billing, Minecraft services, or the JSON store.
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'abeam' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'abeam' }));

// Seed the dev/demo SSID so the bot can hook up before Discord OAuth is set.
// Only ever active in non-production (config.allowDemo is hard-gated).
if (config.allowDemo) {
  upsertStaticToken(config.demoSsid, config.demoEmail);
}

// ---------------------------------------------------------------
// API: SSID access-token auth (bot + scripts)
// ---------------------------------------------------------------
// Auth middleware for API routes: requires a valid SSID.
function requireSsid(req, res, next) {
  const auth = validateToken(tokenFromHeader(req));
  if (!auth) {
    return res.status(401).json({ error: 'invalid or missing ssid' });
  }
  req.user = auth;
  next();
}

// Obtain/rotate a fresh SSID for an email (use to provision bot).
app.post('/api/tokens', (req, res) => {
  const email = (req.body?.email || '').toString().trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'valid email required' });
  }

  // The original endpoint was intentionally open for local bot testing. Do
  // not let an internet user mint an SSID for somebody else's account in
  // production: the new /api/bots routes use this identity as their owner.
  if (config.env === 'production') {
    const session = getSessionUser(req, config.sessionSecret);
    const bearer = validateToken(tokenFromHeader(req));
    const actor = session || (bearer ? { email: bearer.email, via: 'ssid' } : null);
    if (!actor || (String(actor.email || '').toLowerCase() !== email && !isAdmin(actor))) {
      return res.status(403).json({ error: 'sign in as the requested account first' });
    }
  }

  const ssid = createToken(email);
  res.json({ ssid, email });
});

// Guarded health: pings back the authed email.
app.get('/api/me', requireSsid, (req, res) => {
  res.json({ email: req.user.email });
});

// Bot settings (Beam AI key etc.) — trivial passthrough stub.
app.get('/api/settings', requireSsid, (req, res) => {
  res.json({ email: req.user.email });
});
app.put('/api/settings', requireSsid, (req, res) => {
  res.json({ ok: true, email: req.user.email });
});

// ---------------------------------------------------------------
// Email/password auth (dashboard login)
// ---------------------------------------------------------------
// The reference UI calls these endpoints with a username. The original
// backend used email addresses, so local usernames are stored in an internal
// `local:` account namespace while email logins remain compatible.
function accountKeyForLogin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = normalizeEmail(raw);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return normalized;
  const slug = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug ? `local:${slug}` : '';
}

function displayNameForAccount(value, fallback = 'user') {
  const raw = String(value || '').trim();
  if (raw.startsWith('local:')) return raw.slice('local:'.length) || fallback;
  if (raw.includes('@')) return raw.split('@')[0] || fallback;
  return raw || fallback;
}

function rememberWebUser(user) {
  const users = store.users.all();
  const key = resolveAccountKey(user);
  const index = users.findIndex((entry) => resolveAccountKey(entry) === key);
  const existing = index >= 0 ? users[index] : null;
  const next = {
    ...(existing || {}),
    ...user,
    email: key,
    username: user.username || existing?.username || displayNameForAccount(key),
    createdAt: existing?.createdAt || Date.now(),
    role: user.role || existing?.role || (users.length === 0 ? 'admin' : 'user'),
  };
  if (index >= 0) users[index] = next;
  else users.push(next);
  store.users.save(users);
  return next;
}

function publicWebUser(user) {
  if (!user) return null;
  const remembered = rememberWebUser(user);
  const email = String(remembered.email || '').trim().toLowerCase();
  const admin = isAdmin(remembered);
  return {
    id: remembered.id || remembered.discordId || email,
    username: remembered.username || displayNameForAccount(email),
    avatar: remembered.avatar || null,
    role: admin ? 'admin' : 'user',
    botSlots: admin ? -1 : botQuota(email, false),
    botCount: countBots(email),
    isGuest: remembered.via === 'guest',
    licenseStatus: referenceSlotStatus(email, admin),
  };
}

function localIdentity(rawValue, password, via = 'password') {
  const key = accountKeyForLogin(rawValue);
  if (!key) return null;
  const name = displayNameForAccount(key);
  const users = store.users.all();
  const existing = users.find((entry) => resolveAccountKey(entry) === key);
  const user = rememberWebUser({
    email: key,
    username: name,
    via,
    role: existing?.role || (users.length === 0 ? 'admin' : 'user'),
  });
  if (password !== undefined) {
    setPasswordUser(key, password);
  }
  ensureLocalTrial(key);
  return user;
}

function createLocalAccount(rawValue, password, res) {
  const key = accountKeyForLogin(rawValue);
  if (!key) return { error: 'username required' };
  if (getPasswordUser(key)) return { error: 'username already has an account' };
  if (typeof password !== 'string' || password.length < 6) {
    return { error: 'password must be at least 6 characters' };
  }
  const user = localIdentity(rawValue, password, 'password');
  if (res) createSession(config.sessionSecret, user, res);
  return { user };
}

app.post('/api/auth/signup', (req, res) => {
  const result = createLocalAccount(req.body?.email, req.body?.password, res);
  if (result.error) return res.status(result.error.includes('already') ? 409 : 400).json({ error: result.error });
  res.json({ ok: true, email: result.user.email, user: publicWebUser(result.user) });
});

app.post('/api/auth/register', (req, res) => {
  const result = createLocalAccount(req.body?.username ?? req.body?.email, req.body?.password, res);
  if (result.error) return res.status(result.error.includes('already') ? 409 : 400).json({ error: result.error });
  res.json({ ok: true, user: publicWebUser(result.user) });
});

app.post('/api/auth/login', (req, res) => {
  const key = accountKeyForLogin(req.body?.username ?? req.body?.email);
  const user = checkLogin(key, req.body?.password);
  if (!user) {
    return res.status(401).json({ error: 'wrong username or password' });
  }
  const remembered = rememberWebUser({
    ...user,
    email: key,
    username: displayNameForAccount(key),
    via: 'password',
  });
  createSession(config.sessionSecret, remembered, res);
  res.json({ ok: true, email: key, user: publicWebUser(remembered) });
});

app.post('/api/auth/dev-login', (req, res) => {
  if (config.discordClientId && config.discordClientSecret) {
    return res.status(403).json({ error: 'guest_login_disabled' });
  }
  const name = String(req.body?.name || 'guest').trim().slice(0, 48) || 'guest';
  const user = localIdentity(name, undefined, 'guest');
  createSession(config.sessionSecret, user, res);
  res.json({ ok: true, user: publicWebUser(user) });
});

app.get('/api/auth/me', (req, res) => {
  const user = getSessionUser(req, config.sessionSecret);
  res.json({
    user: user ? publicWebUser(user) : null,
    discordConfigured: !!(config.discordClientId && config.discordClientSecret),
  });
});

app.post('/api/auth/logout', (req, res) => {
  destroySession(config.sessionSecret, req, res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// Discord OAuth (website login)
// ---------------------------------------------------------------
const DISCORD_AUTH_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';

app.get('/api/auth/discord/login', (req, res) => {
  res.redirect('/login/discord');
});

app.get('/login/discord', (req, res) => {
  if (!config.discordClientId) {
    return res.redirect('/?error=discord_not_configured');
  }
  const state = Math.random().toString(36).slice(2);
  const params = new URLSearchParams({
    client_id: config.discordClientId,
    redirect_uri: `${config.appUrl}/login/discord/callback`,
    response_type: 'code',
    scope: 'identify email',
    state,
  });
  res.redirect(`${DISCORD_AUTH_URL}?${params}`);
});

app.get('/login/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await fetch(DISCORD_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${config.appUrl}/login/discord/callback`,
        scope: 'identify email',
      }),
    });
    if (!tokenRes.ok) throw new Error('token exchange failed');
    const tokens = await tokenRes.json();

    const meRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const me = await meRes.json();

    const accountKey = resolveAccountKey(me);
    const user = {
      discordId: me.id,
      username: me.username,
      email: accountKey,
      avatar: me.avatar
        ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png`
        : null,
      accountKey,
    };
    createSession(config.sessionSecret, user, res);
    res.redirect('/');
  } catch (err) {
    res.redirect('/?error=discord_login_failed');
  }
});

app.get('/logout', (req, res) => {
  destroySession(config.sessionSecret, req, res);
  res.redirect('/');
});

// Web "who am I" for the dashboard.
app.get('/api/me/web', (req, res) => {
  const user = getSessionUser(req, config.sessionSecret);
  res.json({ user, isAdmin: isAdmin(user) });
});

// Require a Discord web session for purchasing / managing slots.
// Also accepts a valid SSID bearer token, so dev/demo logins work too.
function requireWeb(req, res, next) {
  const session = getSessionUser(req, config.sessionSecret);
  if (session) {
    req.web = session;
    return next();
  }
  const auth = validateToken(tokenFromHeader(req));
  if (auth) {
    req.web = { email: auth.email, via: 'ssid' };
    return next();
  }
  return res.status(401).json({ error: 'not_signed_in' });
}

// Operator-only routes. Identity-gated (no token ever crosses the wire);
// the admin token is only ever used server-side.
function requireAdmin(req, res, next) {
  const route = req.method + ' ' + req.path;
  const session = getSessionUser(req, config.sessionSecret);
  if (!session) {
    console.log('[admin] ' + route + ' -> NO_SESSION (have cookie? ' + (/abeam_session=/.test(req.headers.cookie || '')) + ')');
    return res.status(401).json({ error: 'not_signed_in' });
  }
  if (!isAdmin(session)) {
    console.log('[admin] ' + route + ' -> NOT_ADMIN (email=' + session.email + ' discord=' + session.discordId + ')');
    return res.status(403).json({ error: 'not_admin' });
  }
  console.log('[admin] ' + route + ' -> OK (' + (session.email || session.discordId) + ')');
  req.web = session;
  next();
}

function maskSid(s) {
  if (!s) return '';
  return s.length <= 8 ? '••••' : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function stopBotsFor(email) {
  const sub = getSubscriber(email);
  (sub?.targetServers || []).forEach((server) => {
    if (server) supervisor.stopSlot(`${email}|${server}`);
  });
}

// ---------------------------------------------------------------
// Created bot API (Azalea runtime)
// ---------------------------------------------------------------
// This is the backend equivalent of mc-bot-manager's /api/bots routes. It is
// deliberately separate from /api/slots, which controls the legacy external
// abeam executable. Created bots run through the compiled Azalea sidecar; a
// bot belongs to the signed-in account and its Minecraft bearer token is
// accepted on write but never returned in JSON.
function requireBotUser(req, res, next) {
  return requireWeb(req, res, next);
}

function botRecordForRequest(req, id) {
  const record = getBot(id);
  if (!record) return { record: null, allowed: false };
  const owner = String(req.web?.email || '').trim().toLowerCase();
  const allowed = isAdmin(req.web) || String(record.ownerEmail || '').toLowerCase() === owner;
  return { record, allowed };
}

function botQuota(email, admin = false) {
  // -1 is the JSON-safe representation of unlimited admin capacity.
  if (admin) return -1;
  const sub = getSubscriber(email);
  if (!sub || !isActiveSubscriber(email) || (sub.status && sub.status !== 'active')) return 0;
  return Number(sub.botSlots) || 0;
}

function referenceSlotStatus(email, admin = false) {
  const totalSlots = botQuota(email, admin);
  const usedSlots = countBots(email);
  const sub = getSubscriber(email);
  return {
    totalSlots,
    usedSlots,
    availableSlots: totalSlots < 0 ? -1 : Math.max(0, totalSlots - usedSlots),
    activeLicenses: [],
    expiredLicenses: [],
    hasActiveLicense: totalSlots !== 0,
    nextExpiry: sub?.expiresAt ? new Date(Number(sub.expiresAt)).toISOString() : null,
  };
}

function publicBotById(req, id) {
  const rows = listBots(req.web.email, isAdmin(req.web));
  return rows.find((row) => row.id === id) || null;
}

function referenceBeamState(id) {
  const state = getBeamState(id) || {};
  return {
    ...state,
    looping: !!state.enabled,
    stage: state.target ? `talking to ${state.target}` : '',
  };
}

app.get('/api/bots', requireBotUser, (req, res) => {
  res.json({
    bots: listBots(req.web.email, isAdmin(req.web)),
    slots: botQuota(req.web.email, isAdmin(req.web)),
    used: countBots(req.web.email),
    licenseStatus: referenceSlotStatus(req.web.email, isAdmin(req.web)),
  });
});

app.post('/api/bots', requireBotUser, (req, res) => {
  const admin = isAdmin(req.web);
  const quota = botQuota(req.web.email, admin);
  const used = countBots(req.web.email);
  if (!admin && quota <= 0) {
    return res.status(403).json({ error: 'no_active_plan', message: 'An active plan with bot slots is required.' });
  }
  if (quota >= 0 && used >= quota) {
    return res.status(403).json({ error: 'bot_slots_exhausted', slots: quota, used });
  }
  try {
    const record = createManagedBot(req.web.email, req.body || {});
    // Match the reference manager: creation persists first, then connection is
    // kicked off without blocking the HTTP response on the Minecraft handshake.
    void enableBot(record.id);
    return res.status(201).json({
      bot: publicBotById(req, record.id),
      slots: quota,
      used: used + 1,
    });
  } catch (error) {
    return res.status(400).json({ error: error?.message || 'invalid bot configuration' });
  }
});

app.get('/api/bots/:id', requireBotUser, (req, res) => {
  const { record, allowed } = botRecordForRequest(req, req.params.id);
  if (!record) return res.status(404).json({ error: 'bot_not_found' });
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  res.json({ bot: publicBotById(req, req.params.id) });
});

app.patch('/api/bots/:id', requireBotUser, async (req, res) => {
  const { record, allowed } = botRecordForRequest(req, req.params.id);
  if (!record) return res.status(404).json({ error: 'bot_not_found' });
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  try {
    const input = { ...(req.body || {}) };
    const requestedEnabled = input.enabled;
    delete input.enabled;
    const wasActive = ['online', 'connecting'].includes(getRuntimeView(req.params.id).status);
    await updateManagedBot(req.params.id, input, { restart: requestedEnabled !== false });
    if (requestedEnabled === true && !wasActive) await enableBot(req.params.id);
    if (requestedEnabled === false) await disableBot(req.params.id);
    res.json({ ok: true, bot: publicBotById(req, req.params.id) });
  } catch (error) {
    res.status(400).json({ error: error?.message || 'invalid bot update' });
  }
});

app.delete('/api/bots/:id', requireBotUser, async (req, res) => {
  const { record, allowed } = botRecordForRequest(req, req.params.id);
  if (!record) return res.status(404).json({ error: 'bot_not_found' });
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  await deleteManagedBot(req.params.id);
  res.json({ ok: true });
});

app.post('/api/bots/:id/start', requireBotUser, async (req, res) => {
  const { record, allowed } = botRecordForRequest(req, req.params.id);
  if (!record) return res.status(404).json({ error: 'bot_not_found' });
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  await enableBot(req.params.id);
  res.status(202).json({ ok: true, bot: publicBotById(req, req.params.id) });
});

app.post('/api/bots/:id/stop', requireBotUser, async (req, res) => {
  const { record, allowed } = botRecordForRequest(req, req.params.id);
  if (!record) return res.status(404).json({ error: 'bot_not_found' });
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  await disableBot(req.params.id);
  res.json({ ok: true, bot: publicBotById(req, req.params.id) });
});

app.get('/api/bots/:id/console', requireBotUser, (req, res) => {
  const { record, allowed } = botRecordForRequest(req, req.params.id);
  if (!record) return res.status(404).json({ error: 'bot_not_found' });
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  res.json({
    logs: getLogs(req.params.id),
    ...getRuntimeView(req.params.id),
    beam: referenceBeamState(req.params.id),
  });
});

app.post('/api/bots/:id/console', requireBotUser, (req, res) => {
  const { record, allowed } = botRecordForRequest(req, req.params.id);
  if (!record) return res.status(404).json({ error: 'bot_not_found' });
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message_required' });
  if (!sendChat(req.params.id, message)) {
    return res.status(409).json({ error: 'bot_offline' });
  }
  res.json({ ok: true });
});

app.get('/api/bots/:id/view', requireBotUser, (req, res) => {
  const { record, allowed } = botRecordForRequest(req, req.params.id);
  if (!record) return res.status(404).json({ error: 'bot_not_found' });
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  res.json({ ...getRuntimeView(req.params.id), snapshot: getViewSnapshot(req.params.id), beam: referenceBeamState(req.params.id) });
});

app.post('/api/bots/:id/action', requireBotUser, async (req, res) => {
  const { record, allowed } = botRecordForRequest(req, req.params.id);
  if (!record) return res.status(404).json({ error: 'bot_not_found' });
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  const action = String(req.body?.action || '');
  let result;
  switch (action) {
    case 'select':
      result = await selectHotbarSlot(req.params.id, Number(req.body?.slot ?? 0));
      break;
    case 'use':
      result = await useHeldItem(req.params.id);
      break;
    case 'drop':
      result = await dropHeldItem(req.params.id);
      break;
    case 'move':
      result = await moveBot(req.params.id, req.body?.dir || 'forward');
      break;
    case 'clickWindow':
      result = await clickWindowSlot(req.params.id, Number(req.body?.slot ?? 0));
      break;
    case 'closeWindow':
      result = await closeWindow(req.params.id);
      break;
    case 'beam':
    case 'beam_start':
      result = await startBeam(req.params.id, req.body?.target || '');
      break;
    case 'beam_stop':
      result = await stopBeam(req.params.id);
      break;
    default:
      return res.status(400).json({ error: 'unknown_action' });
  }
  if (!result.ok) return res.status(409).json({ error: result.message });
  res.json(result);
});

// ---------------------------------------------------------------
// Pricing + checkout (LTC billing)
// ---------------------------------------------------------------
app.get('/api/plans', (req, res) => {
  res.json({
    plans: paidPlans(),
    ltcUsdRate: config.ltcUsdRate,
    discordConfigured: !!(config.discordClientId && config.discordClientSecret),
    demoAllowed: !!config.allowDemo,
  });
});

function referenceShopPlan(plan) {
  return {
    id: plan.id,
    tier: plan.name,
    price: plan.priceUsd,
    finalPrice: plan.priceUsd,
    bots: plan.botSlots,
    // The legacy plan model is monthly; keep the reference card's daily
    // capacity wording without changing the plan's actual entitlement.
    hours: 24,
    features: plan.features || [],
    popular: !!plan.popular,
    active: true,
    discount: 0,
  };
}

function referenceInvoice(invoice) {
  const plan = planById(invoice?.planId);
  const createdAt = new Date(Number(invoice?.created || Date.now()));
  const expiresAt = new Date(createdAt.getTime() + Math.min(config.invoiceTtlMs, 30 * 60 * 1000));
  let ownerLtcAddress = '';
  try {
    ownerLtcAddress = ownerAddress();
  } catch {
    // A production deployment without LTC_SEED can still browse the shop.
  }
  return {
    id: invoice.id,
    planId: invoice.planId,
    amountUSD: Number(invoice.amountUsd || 0),
    amountLTC: Number(invoice.amountLtc || 0).toFixed(6),
    ltcAddress: invoice.address,
    ownerLtcAddress,
    status: invoice.status,
    expiresAt: expiresAt.toISOString(),
    createdAt: createdAt.toISOString(),
    tier: plan?.name || invoice.planId,
    bots: plan?.botSlots || 0,
    hours: 24,
    licenseKey: invoice.licenseKey || null,
  };
}

function ensureShopLicense(invoice) {
  if (!invoice || !invoice.planId || invoice.creditKind === 'credits') return null;
  if (!invoice.licenseKey) {
    invoice.licenseKey = generateLicenseKey(invoice.planId, 'shop', 1);
    const all = store.invoices.all();
    store.invoices.save(all.map((entry) => (entry.id === invoice.id ? invoice : entry)));
  }
  return invoice.licenseKey;
}

// Compatibility routes for the reference shop panel. They translate the
// existing Abeam LTC invoice model instead of introducing a second store.
app.get('/api/shop/plans', async (_req, res) => {
  let ltcPrice = Number(config.ltcUsdRate) || 0;
  try {
    ltcPrice = await fetchLtcPrice();
  } catch {}
  res.json({ plans: paidPlans().map(referenceShopPlan), ltcPrice });
});

app.get('/api/shop/invoices', requireWeb, (req, res) => {
  const invoices = store.invoices
    .all()
    .filter((invoice) => invoice.email === req.web.email)
    .reverse()
    .map(referenceInvoice);
  res.json({ invoices });
});

app.post('/api/shop/invoices', requireWeb, async (req, res) => {
  try {
    const invoice = await createInvoice(String(req.body?.planId || ''), req.web.email);
    res.status(201).json({ invoice: referenceInvoice(invoice) });
  } catch (error) {
    res.status(400).json({ error: error?.message || 'could not create invoice' });
  }
});

app.get('/api/shop/invoices/:id', requireWeb, (req, res) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice || invoice.email !== req.web.email) return res.status(404).json({ error: 'invoice not found' });
  res.json({ invoice: referenceInvoice(invoice) });
});

app.delete('/api/shop/invoices/:id', requireWeb, (req, res) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice || invoice.email !== req.web.email) return res.status(404).json({ error: 'invoice not found' });
  if (invoice.status === 'paid') return res.status(400).json({ error: 'invoice already paid' });
  invoice.status = 'cancelled';
  invoice.cancelledAt = Date.now();
  store.invoices.save(store.invoices.all());
  res.json({ ok: true });
});

app.post('/api/shop/invoices/:id/check', requireWeb, async (req, res) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice || invoice.email !== req.web.email) return res.status(404).json({ error: 'invoice not found' });

  if (req.body?.forcePaid && isAdmin(req.web)) {
    markPaid(invoice, 'manual', 0, (paid) => {
      try {
        grantSubscription({ planId: paid.planId, months: 1 }, paid.email);
      } catch {}
    });
  } else if (invoice.status !== 'paid') {
    try {
      const result = await checkAddress(invoice.address);
      const paid = result.ok && result.value >= Number(invoice.amountLtc || 0) && result.confirmations >= config.confirmationsRequired;
      if (paid) {
        markPaid(invoice, result.tx, result.confirmations, (paidInvoice) => {
          try {
            grantSubscription({ planId: paidInvoice.planId, months: 1 }, paidInvoice.email);
          } catch {}
        });
      }
    } catch {
      // Keep the checkout polling-friendly when BlockCypher is rate-limited.
    }
  }

  if (invoice.status !== 'paid') {
    return res.json({ paid: false, balance: '0' });
  }
  const licenseKey = ensureShopLicense(invoice);
  const plan = planById(invoice.planId);
  res.json({
    paid: true,
    licenseKey,
    bots: plan?.botSlots || 0,
    tier: plan?.name || invoice.planId,
  });
});

app.get('/api/shop/settings', requireAdmin, (_req, res) => {
  let ownerLtcAddress = '';
  try {
    ownerLtcAddress = ownerAddress();
  } catch {}
  res.json({ ownerLtcAddress });
});

app.post('/api/shop/settings', requireAdmin, (req, res) => {
  // The wallet address is deterministically derived from LTC_SEED in this
  // backend. Keep the endpoint for the reference admin screen but do not allow
  // an arbitrary address to replace the signing wallet.
  let ownerLtcAddress = '';
  try {
    ownerLtcAddress = ownerAddress();
  } catch {}
  res.json({ ok: true, ownerLtcAddress });
});

// Create an invoice (fresh LTC receive address) for a paid plan.
app.post('/api/plans/:id/invoice', requireWeb, async (req, res) => {
  try {
    const invoice = await createInvoice(req.params.id, req.web.email);
    res.json({ invoice });
  } catch (e) {
    res.status(400).json({ error: e.message || 'could not create invoice' });
  }
});

// Live invoice status + QR (polled by the checkout modal).
app.get('/api/invoices/:id', async (req, res) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'invoice not found' });
  if (!invoice.qr) invoice.qr = await qrDataUrl(invoice.uri);
  res.json({ invoice, explorer: EXPLORER_BASE });
});

app.post('/api/credits/buy', requireWeb, async (req, res) => {
  const { credits } = req.body || {};
  const amount = Math.floor(Number(credits));
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'credits must be a positive integer' });
  }
  const per1000 = 2.5;
  const usd = Number(((amount / 1000) * per1000).toFixed(2));
  try {
    const invoice = await createInvoice('raid', req.web.email, { kind: 'credits', credits: amount, amountUsd: usd });
    res.json({ invoice });
  } catch (e) {
    res.status(400).json({ error: e.message || 'could not create invoice' });
  }
});

// Cancel a pending invoice (only allowed while it's not paid).
app.delete('/api/invoices/:id', requireWeb, (req, res) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'invoice not found' });
  if (invoice.email && invoice.email !== req.web.email) {
    return res.status(403).json({ error: 'not your invoice' });
  }
  if (invoice.status === 'paid') {
    return res.status(400).json({ error: 'invoice already paid' });
  }
  invoice.status = 'cancelled';
  invoice.cancelledAt = Date.now();
  store.invoices.save(store.invoices.all().map((i) => (i.id === invoice.id ? invoice : i)));
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// Account + slot management (paid-only via accountForBearer)
// ---------------------------------------------------------------
// The supervisor reconciles managed abeam.exe bot processes against active
// subscribers. Declared here before the routes that reference it.
const supervisor = new BotSupervisor();

app.get('/api/account', requireWeb, (req, res) => {
  const sub = getSubscriber(req.web.email);
  if (!sub || !sub.planId) {
    return res.json({ entitlement: 'none', email: req.web.email, user: req.web, isAdmin: isAdmin(req.web) });
  }
  const plan = planById(sub.planId);
  res.json({
    entitlement: 'active',
    email: req.web.email,
    user: req.web,
    isAdmin: isAdmin(req.web),
    subscriber: {
      email: sub.email,
      planId: sub.planId,
      planName: plan?.name || sub.planId,
      botSlots: sub.botSlots,
      targets: plan?.targets ?? -1,
      ai: !!plan?.ai,
      servers: sub.targetServers || [],
      ssids: sub.ssids || [],
      ssid: (sub.ssids && sub.ssids[0]) || null,
      mcTokens: (sub.mcTokens || []).map((t) => ({
        mcAccessToken: t?.mcAccessToken ? '••••••••' : '',
        mcUuid: t?.mcUuid || '',
        mcUsername: t?.mcUsername || '',
        mcName: t?.mcName || '',
        mcProxy: t?.mcProxy || '',
        mcVersion: t?.mcVersion || 'auto',
      })),
      since: sub.since,
      expiresAt: sub.expiresAt || null,
      demo: !!sub.demo,
      credits: creditBalance(req.web.email),
    },
  });
});

// A subscriber's license history: current subscription + every invoice paid
// (or pending) for their account. The slot fields mirror the reference UI;
// the invoice/current fields remain for older API consumers.
app.get('/api/licenses', requireWeb, (req, res) => {
  const email = req.web.email;
  const invoices = store.invoices
    .all()
    .filter((i) => i.email === email)
    .reverse();
  const sub = getSubscriber(email);
  const redeemed = store.licenses
    .all()
    .filter((license) => license.redeemedBy === email)
    .reverse();
  const active = !!sub && !!sub.planId && Number(sub.botSlots) > 0 && sub.status !== 'expired' && sub.status !== 'revoked';
  const expiry = active && sub.expiresAt ? new Date(Number(sub.expiresAt)) : null;
  const activeKey = redeemed.find((license) => license.planId === sub?.planId) || null;

  function licenseInfo(license, isActive) {
    const months = Number(license?.months || 0);
    const customDuration = license?.durationDays !== undefined || license?.durationHours !== undefined;
    const durationDays = customDuration ? Number(license?.durationDays || 0) : Math.floor(months * 30);
    const durationHours = customDuration ? Number(license?.durationHours || 0) : (Math.round(months * 30 * 24) % 24);
    const totalDurationMs = (durationDays * 24 + durationHours) * 3_600_000;
    const expiresAt = isActive && sub?.expiresAt
      ? new Date(Number(sub.expiresAt))
      : (license?.redeemedAt && totalDurationMs > 0
        ? new Date(Number(license.redeemedAt) + totalDurationMs)
        : new Date('2099-12-31T23:59:59.000Z'));
    const remaining = expiresAt.getTime() - Date.now();
    const hoursLeft = Math.max(0, Math.floor(remaining / 3_600_000));
    const timeLeft = remaining > 0
      ? `${Math.floor(hoursLeft / 24)}d ${hoursLeft % 24}h left`
      : 'Expired';
    return {
      id: license?.code || `${email}-${sub?.planId || 'license'}`,
      slots: isActive ? Number(sub?.botSlots || 0) : Number(license?.requestedSlots || planById(license?.planId)?.botSlots || 0),
      durationDays,
      durationHours,
      expiresAt: expiresAt.toISOString(),
      active: isActive && remaining > 0,
      reason: license?.reason || (sub?.trial ? 'trial' : ''),
      licenseKey: license?.code,
      createdAt: new Date(Number(license?.created || sub?.since || Date.now())).toISOString(),
      isExpired: remaining <= 0,
      timeLeft,
    };
  }

  const activeLicenses = active ? [licenseInfo(activeKey, true)] : [];
  const expiredLicenses = redeemed
    .filter((license) => !active || license !== activeKey)
    .map((license) => licenseInfo(license, false));
  const totalSlots = active ? Number(sub.botSlots || 0) : 0;
  const usedSlots = countBots(email);

  res.json({
    totalSlots,
    usedSlots,
    availableSlots: Math.max(0, totalSlots - usedSlots),
    activeLicenses,
    expiredLicenses,
    hasActiveLicense: active,
    nextExpiry: expiry && Number.isFinite(expiry.getTime()) ? expiry.toISOString() : null,
    redeemable: true,
    explorer: EXPLORER_BASE,
    invoices: invoices.map((i) => ({
      id: i.id,
      planId: i.planId,
      planName: planById(i.planId)?.name || i.planId,
      amountLtc: i.amountLtc,
      amountUsd: i.amountUsd,
      status: i.status,
      created: i.created,
      paidAt: i.paidAt,
      cancelledAt: i.cancelledAt,
      tx: i.tx,
      address: i.address,
      uri: i.uri,
      creditAmount: i.creditAmount || 0,
    })),
    current: sub
      ? {
          planId: sub.planId,
          planName: planById(sub.planId)?.name || sub.planId,
          botSlots: sub.botSlots,
          status: sub.status,
          since: sub.since,
          trial: !!sub.trial,
          demo: !!sub.demo,
        }
      : null,
  });
});

// Redeem a one-time serial license key; grants its plan to the signed-in account.
app.post('/api/licenses/redeem', requireWeb, (req, res) => {
  const rawCode = String(req.body?.code || req.body?.key || '').trim();
  // Legacy serials were case-insensitive; the reference key format is already
  // lower-case but accepting both keeps old keys redeemable.
  const code = rawCode.toLowerCase().startsWith('abeam-key-') ? rawCode : rawCode.toUpperCase();
  const email = req.web.email;
  if (!code) return res.status(400).json({ error: 'code_required' });
  const result = redeemLicenseKey(code, email);
  if (!result.ok) return res.status(400).json({ error: result.reason });
  if (typeof supervisor?.sync === 'function') supervisor.sync();
  return res.json({
    ok: true,
    planId: result.planId,
    subscriber: result.subscriber,
    license: result.license,
  });
});

// Operator-only: mint serial license keys (default count 1, cap 50).
app.post('/api/licenses/generate', (req, res) => {
  if (!config.adminToken) return res.status(403).json({ error: 'admin_token_not_configured' });
  const sent = String(req.headers['x-admin-token'] || '');
  if (sent !== config.adminToken) return res.status(403).json({ error: 'invalid_admin_token' });
  const planId = String(req.body?.planId || '').trim();
  const count = Math.min(50, Math.max(1, Number(req.body?.count) || 1));
  const months = clampMonths(req.body?.months);
  try {
    const keys = [];
    for (let i = 0; i < count; i++) keys.push(generateLicenseKey(planId, 'admin', months));
    return res.json({ ok: true, keys });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'generate_failed' });
  }
});

// Operator overview: every subscriber on the platform.
app.get('/api/admin/subscribers', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const all = store.subscribers.all() || {};
  const rows = Object.entries(all)
    .filter(([email]) => !q || email.toLowerCase().includes(q))
    .map(([email, s]) => ({
      email,
      planId: s.planId || null,
      planName: s.planName || null,
      botSlots: Number(s.botSlots) || 0,
      status: s.status || 'inactive',
      since: s.since || null,
      expiresAt: s.expiresAt || null,
      credits: Number(s.creditsBalance ?? s.credits ?? 0) || 0,
      demo: !!s.demo,
      trial: !!s.trial,
      servers: (s.targetServers || []).length,
      ssids: (s.ssids || []).length,
      online: Object.keys(supervisor.slotStatus(email) || {}).length,
    }));
  rows.sort((a, b) => (a.planId ? -1 : 1));
  res.json({ subscribers: rows });
});

// Operator: full subscriber detail (credentials masked).
app.get('/api/admin/subscribers/:email', requireAdmin, (req, res) => {
  const key = String(req.params.email).trim().toLowerCase();
  const sub = getSubscriber(key);
  if (!sub) return res.status(404).json({ error: 'no_such_subscriber' });
  const online = supervisor.slotStatus(key) || {};
  res.json({
    email: key,
    planId: sub.planId || null,
    planName: sub.planName || null,
    botSlots: Number(sub.botSlots) || 0,
    status: sub.status || 'inactive',
    since: sub.since || null,
    demo: !!sub.demo,
    trial: !!sub.trial,
    servers: sub.targetServers || [],
    ssids: (sub.ssids || []).map((s) => (typeof s === 'string' ? maskSid(s) : null)).filter(Boolean),
    online: Object.keys(online).length,
    onlineServers: Object.keys(online),
    credits: creditBalance(key),
    mcTokens: (sub.mcTokens || []).map((t) => ({
      has: !!t,
      username: t?.username || null,
      uuid: t?.uuid || null,
    })),
    configs: (sub.configs || []).map((c) =>
      c ? { has: true, persona: c?.persona?.name || null, ai: !!c?.ai?.enabled } : { has: false },
    ),
    invoices: store.invoices.all().filter((i) => i.email === key).map((i) => ({
      id: i.id,
      planId: i.planId,
      status: i.status,
      amountUsd: i.amountUsd,
      amountLtc: i.amountLtc,
      created: i.created,
      paidAt: i.paidAt,
      address: i.address,
    })),
    licenses: store.licenses.all().filter((l) => l.redeemedBy === key).map((l) => ({
      code: maskSid(l.code),
      planId: l.planId,
      redeemedAt: l.redeemedAt,
    })),
  });
});

// Operator: every web user on the site (all users.json), not just subscribers.
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const users = store.users.all() || [];
  const subMap = store.subscribers.all() || {};
  const rows = users
    .filter((u) => {
      const key = resolveAccountKey(u);
      const hit = !q
        || key.toLowerCase().includes(q)
        || String(u.discordId || '').includes(q)
        || String(u.username || '').toLowerCase().includes(q);
      return hit;
    })
    .map((u) => {
      const key = resolveAccountKey(u);
      const sub = subMap[key] || null;
      const online = sub ? Object.keys(supervisor.slotStatus(key) || {}).length : 0;
      return {
        id: key,
        key,
        email: sub?.email || u.email || null,
        username: u.username || null,
        avatar: u.avatar || null,
        discordId: u.discordId || null,
        role: isAdmin(u) ? 'admin' : 'user',
        botCount: countBots(key),
        botsOnline: online,
        via: u.via || (u.discordId ? 'discord' : 'backend'),
        created: u.created || u.createdAt || u.since || null,
        createdAt: u.created || u.createdAt || u.since || new Date().toISOString(),
        admin: isAdmin(u),
        isGuest: u.via === 'guest',
        planId: sub?.planId || null,
        planName: sub?.planName || null,
        botSlots: Number(sub?.botSlots) || 0,
        status: sub?.status || 'none',
        demo: !!sub?.demo,
        trial: !!sub?.trial,
        servers: (sub?.targetServers || []).length,
        online,
      };
    });
  rows.sort((a, b) => ((b.planId ? 1 : 0) - (a.planId ? 1 : 0)) || ((b.online || 0) - (a.online || 0)));
  res.json({ users: rows, total: (store.users.all() || []).length });
});

function adminAccountKey(raw) {
  return decodeURIComponent(String(raw || '')).trim().toLowerCase();
}

function ensureAdminSubscriber(email) {
  const all = store.subscribers.all();
  const existing = all[email];
  if (existing) return existing;
  const sub = {
    email,
    planId: null,
    botSlots: 0,
    ssids: [],
    targetServers: [],
    configs: [],
    since: Date.now(),
    status: 'inactive',
  };
  all[email] = sub;
  store.subscribers.save(all);
  return sub;
}

// Reference AdminPanel compatibility: user-centric management wrappers over
// the current email/local-account and persisted-bot stores.
app.get('/api/admin/users/:id/bots', requireAdmin, (req, res) => {
  const key = adminAccountKey(req.params.id);
  res.json({ bots: listBots(key, false) });
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const key = adminAccountKey(req.params.id);
  const patch = req.body || {};
  if (patch.botSlots !== undefined) {
    const slots = Number(patch.botSlots);
    if (!Number.isInteger(slots) || slots < 0 || slots > 50) {
      return res.status(400).json({ error: 'invalid_slot_count' });
    }
    const sub = ensureAdminSubscriber(key);
    sub.botSlots = slots;
    sub.status = slots > 0 ? 'active' : 'inactive';
    if (slots > 0 && !sub.planId) sub.planId = slots <= 1 ? 'ace' : slots <= 4 ? 'raid' : 'storm';
    const all = store.subscribers.all();
    all[key] = sub;
    store.subscribers.save(all);
  }
  if (patch.role !== undefined) {
    const users = store.users.all();
    const index = users.findIndex((entry) => resolveAccountKey(entry) === key);
    if (index >= 0) {
      users[index] = { ...users[index], role: patch.role === 'admin' ? 'admin' : 'user' };
      store.users.save(users);
    }
  }
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const key = adminAccountKey(req.params.id);
  for (const bot of listBots(key, false)) {
    await deleteManagedBot(bot.id);
  }
  const users = store.users.all().filter((entry) => resolveAccountKey(entry) !== key);
  store.users.save(users);
  const subscribers = store.subscribers.all();
  delete subscribers[key];
  store.subscribers.save(subscribers);
  const sessions = store.sessions.all();
  for (const [sid, record] of Object.entries(sessions)) {
    if (record && resolveAccountKey(record.user) === key) delete sessions[sid];
  }
  store.sessions.save(sessions);
  res.json({ ok: true });
});

app.post('/api/admin/users/create', requireAdmin, (req, res) => {
  const result = createLocalAccount(req.body?.username, req.body?.password, null);
  if (result.error) return res.status(result.error.includes('already') ? 409 : 400).json({ error: result.error });
  const key = result.user.email;
  if (req.body?.role === 'admin') {
    const users = store.users.all();
    const index = users.findIndex((entry) => resolveAccountKey(entry) === key);
    if (index >= 0) {
      users[index] = { ...users[index], role: 'admin' };
      store.users.save(users);
    }
  }
  res.json({ ok: true, user: publicWebUser(result.user) });
});

function adminLicenseKeyView(key) {
  const plan = planById(key.planId);
  const customDuration = key.durationDays !== undefined || key.durationHours !== undefined;
  const durationHours = Math.max(0, Math.round(Number(key.months || 0) * 30 * 24));
  return {
    id: key.code,
    key: key.code,
    slots: Number(key.requestedSlots || plan?.botSlots || 0),
    durationDays: customDuration ? Number(key.durationDays || 0) : Math.floor(durationHours / 24),
    durationHours: customDuration ? Number(key.durationHours || 0) : durationHours % 24,
    reason: key.reason || '',
    active: !key.redeemedAt,
    redeemed: !!key.redeemedAt,
    redeemedBy: key.redeemedBy || null,
    redeemedByUsername: key.redeemedBy || null,
    redeemedAt: key.redeemedAt ? new Date(key.redeemedAt).toISOString() : null,
    createdAt: new Date(Number(key.created || Date.now())).toISOString(),
  };
}

app.get('/api/admin/licenses', requireAdmin, (_req, res) => {
  const licenseKeys = store.licenses.all().slice().reverse().map(adminLicenseKeyView);
  const licenses = Object.values(store.subscribers.all()).filter((sub) => sub.planId).map((sub) => ({
    id: `${sub.email}:${sub.planId}`,
    userId: sub.email,
    username: sub.email,
    slots: Number(sub.botSlots || 0),
    durationDays: sub.expiresAt ? Math.max(0, Math.floor((Number(sub.expiresAt) - Number(sub.since || Date.now())) / 86_400_000)) : 0,
    durationHours: 0,
    expiresAt: sub.expiresAt ? new Date(Number(sub.expiresAt)).toISOString() : new Date('2099-12-31T23:59:59.000Z').toISOString(),
    active: sub.status !== 'expired' && sub.status !== 'revoked',
    reason: sub.trial ? 'trial' : '',
    createdAt: new Date(Number(sub.since || Date.now())).toISOString(),
    isExpired: sub.status === 'expired',
    timeLeft: sub.expiresAt ? `${Math.max(0, Math.floor((Number(sub.expiresAt) - Date.now()) / 86_400_000))}d` : 'Lifetime',
  }));
  res.json({ licenseKeys, licenses });
});

app.post('/api/admin/licenses', requireAdmin, (req, res) => {
  const slots = Math.max(1, Math.min(50, Number(req.body?.slots) || 1));
  const days = Math.max(0, Math.min(3650, Number(req.body?.durationDays) || 0));
  const hours = Math.max(0, Math.min(23, Number(req.body?.durationHours) || 0));
  const planId = slots <= 1 ? 'ace' : slots <= 4 ? 'raid' : 'storm';
  const months = Math.max(1, Math.round((days + hours / 24) / 30));
  try {
    const code = generateLicenseKey(planId, req.web?.email || 'admin', months);
    const all = store.licenses.all();
    const key = all.find((entry) => entry.code === code);
    if (key) {
      key.reason = String(req.body?.reason || '').trim().slice(0, 160);
      key.requestedSlots = slots;
      key.durationDays = days;
      key.durationHours = hours;
      store.licenses.save(all);
    }
    res.status(201).json({ ok: true, key: code, licenseKey: adminLicenseKeyView(key || { code, planId, months, created: Date.now() }) });
  } catch (error) {
    res.status(400).json({ error: error?.message || 'generate_failed' });
  }
});

app.patch('/api/admin/licenses/:id', requireAdmin, (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const type = String(req.body?.type || 'key');
  if (type === 'key') {
    const all = store.licenses.all();
    const key = all.find((entry) => entry.code === id);
    if (!key) return res.status(404).json({ error: 'not_found' });
    if (req.body?.action === 'revoke') key.revoked = true;
    store.licenses.save(all);
  }
  res.json({ ok: true });
});

const TRAINING_CONFIG_KEY = 'beamTraining';
function trainingState() {
  const all = store.config.all();
  return all[TRAINING_CONFIG_KEY] || { enabled: false, learnings: '' };
}

app.get('/api/admin/training', requireAdmin, (_req, res) => {
  const state = trainingState();
  const conversations = store.conversations.all().map((conversation, index) => ({
    id: conversation.id || `conversation-${index}`,
    target: conversation.target || conversation.targetName || null,
    outcome: conversation.outcome || 'stopped',
    transcript: conversation.transcript || conversation.messages || [],
    createdAt: new Date(Number(conversation.createdAt || conversation.startedAt || Date.now())).toISOString(),
  }));
  res.json({ training: !!state.enabled, learnings: state.learnings || '', conversations });
});

app.post('/api/admin/training', requireAdmin, (req, res) => {
  const all = store.config.all();
  const state = { ...trainingState() };
  const action = String(req.body?.action || '');
  if (action === 'toggle') state.enabled = !!req.body?.value;
  if (action === 'save_learnings') state.learnings = String(req.body?.learnings || '').slice(0, 20_000);
  if (action === 'clear') store.conversations.save([]);
  if (action === 'analyze') {
    const total = store.conversations.all().length;
    state.learnings = state.learnings || (total ? 'Prefer concise, natural replies and respect the player\'s tone.' : '');
    all[TRAINING_CONFIG_KEY] = state;
    store.config.save(all);
    return res.json({ ok: total > 0, analyzed: total, learnings: state.learnings });
  }
  all[TRAINING_CONFIG_KEY] = state;
  store.config.save(all);
  res.json({ ok: true, training: !!state.enabled, learnings: state.learnings || '' });
});

// Operator: owner wallet / revenue overview (paid invoices + balance owed).
app.get('/api/admin/wallet', requireAdmin, (req, res) => {
  const invoices = store.invoices.all().filter((i) => i.status === 'paid');
  const revenueUsd = invoices.reduce((n, i) => n + (Number(i.amountUsd) || 0), 0);
  const revenueLtc = invoices.reduce((n, i) => n + (Number(i.amountLtc) || 0), 0);
  const byPlan = {};
  for (const i of invoices) {
    const kind = i.creditKind === 'credits' ? 'credits' : (i.planId || 'plan');
    byPlan[kind] = (byPlan[kind] || 0) + (Number(i.amountUsd) || 0);
  }
  const creditsBought = invoices
    .filter((i) => i.creditKind === 'credits')
    .reduce((n, i) => n + (Number(i.creditAmount) || 0), 0);
  const pendingCount = store.invoices.all().filter((i) => i.status === 'pending').length;
  res.json({
    revenueUsd: Number(revenueUsd.toFixed(2)),
    revenueLtc: Number(revenueLtc.toFixed(4)),
    paidCount: invoices.length,
    pendingCount,
    creditsBought,
    byPlan: Object.fromEntries(Object.entries(byPlan).sort((a, b) => b[1] - a[1])),
    ltcUsdRate: config.ltcUsdRate,
  });
});

// Owner wallet (separate from admin stats): receive / sweep / send / history.
// All invoice balances sweep into this single owner address.
app.get('/api/ltc-price', requireAdmin, async (req, res) => {
  try {
    const price = await fetchLtcPrice();
    res.json({ ok: true, ltcUsd: price });
  } catch (e) {
    res.json({ ok: true, ltcUsd: 100 });
  }
});

app.get('/api/owner/wallet', requireAdmin, async (req, res) => {
  try {
    res.json(await getWalletData());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/owner/wallet/address', requireAdmin, (req, res) => {
  res.json({ ok: true, address: ownerAddress() });
});

app.post('/api/owner/wallet/sweep', requireAdmin, async (req, res) => {
  try {
    const results = await sweepAll();
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/owner/wallet/send', requireAdmin, async (req, res) => {
  try {
    const { to, amountLtc } = req.body || {};
    const sats = Math.round(Number(amountLtc) * 1e8);
    if (!to || !Number.isFinite(sats) || sats <= 0) {
      return res.status(400).json({ ok: false, error: 'address and amount required' });
    }
    const r = await sendFromWallet(to, sats);
    res.json(r);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'send failed' });
  }
});

app.get('/api/owner/wallet/txs', requireAdmin, (req, res) => {
  res.json({ ok: true, txs: store.walletLedger.all().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 200) });
});

// Operator: patch plan / status / slots / credits for a subscriber.
app.put('/api/admin/subscribers/:email', requireAdmin, (req, res) => {
  const key = String(req.params.email).trim().toLowerCase();
  try {
    const sub = patchSubscriber(key, req.body || {});
    if (req.body?.addCredits !== undefined) {
      const c = Number(req.body.addCredits);
      if (!Number.isFinite(c)) return res.status(400).json({ error: 'invalid_credits' });
      grantCreditTopup(key, c);
    }
    if (!sub.planId || sub.status === 'revoked' || sub.status === 'inactive' || !sub.botSlots) {
      stopBotsFor(key);
    }
    supervisor.sync();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || 'invalid_patch' });
  }
});

// Operator: grant a plan + fresh SSID (manual sale / support).
app.post('/api/admin/subscribers/:email/grant', requireAdmin, (req, res) => {
  const key = String(req.params.email).trim().toLowerCase();
  const planId = String(req.body?.planId || '').trim();
  if (!planId || !planById(planId)) return res.status(400).json({ error: 'invalid_plan' });
  try {
    const { subscriber, ssid } = grantSubscription({ planId }, key);
    supervisor.sync();
    res.json({ ok: true, email: key, planId, botSlots: subscriber.botSlots, ssid });
  } catch (e) {
    res.status(400).json({ error: e.message || 'grant_failed' });
  }
});

// Operator: mint another long-lived SSID for a subscriber (rotation).
app.post('/api/admin/subscribers/:email/ssid', requireAdmin, (req, res) => {
  const key = String(req.params.email).trim().toLowerCase();
  const sub = getSubscriber(key);
  if (!sub) return res.status(404).json({ error: 'no_such_subscriber' });
  const ssid = createToken(key, 1000 * 60 * 60 * 24 * 365); // 1yr
  sub.ssids = sub.ssids || [];
  sub.ssids.push(ssid);
  if (sub.ssids.length > 8) sub.ssids = sub.ssids.slice(-8);
  const all = store.subscribers.all();
  all[key] = sub;
  store.subscribers.save(all);
  res.json({ ok: true, ssid });
});

// Operator: hard-delete a subscriber (stops bots, purges web sessions).
app.delete('/api/admin/subscribers/:email', requireAdmin, (req, res) => {
  const key = String(req.params.email).trim().toLowerCase();
  stopBotsFor(key);
  const sessions = store.sessions.all();
  for (const [sid, rec] of Object.entries(sessions)) {
    if (rec && resolveAccountKey(rec.user) === key) delete sessions[sid];
  }
  store.sessions.save(sessions);
  const all = store.subscribers.all();
  const existed = !!all[key];
  delete all[key];
  store.subscribers.save(all);
  res.json({ ok: true, existed });
});

// Operator-only: mint serial license keys (identity-gated; token stays server-side).
app.post('/api/admin/licenses/generate', requireAdmin, (req, res) => {
  console.log('[admin] generate requested by', (req.web && (req.web.email || req.web.discordId)) || 'unknown');
  if (!config.adminToken) return res.status(503).json({ error: 'admin_token_not_configured' });
  const planId = String(req.body?.planId || '').trim();
  const count = Math.min(50, Math.max(1, Number(req.body?.count) || 1));
  const months = clampMonths(req.body?.months);
  try {
    const keys = [];
    for (let i = 0; i < count; i++) keys.push(generateLicenseKey(planId, 'admin', months));
    console.log('[admin] generated', keys.length, 'keys for plan', planId, 'months', months);
    return res.json({ ok: true, keys });
  } catch (e) {
    console.log('[admin] generate failed:', e.message);
    return res.status(400).json({ error: e.message || 'generate_failed' });
  }
});

// Operator-only: post a devlog entry with optional images to Discord.
app.post('/api/admin/devlog', requireAdmin, async (req, res) => {
  const { title, body, images, tag, color } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });
  const imageUrls = Array.isArray(images)
    ? images.map((u) => String(u).trim()).filter(Boolean).slice(0, 9)
    : [];
  await logDevlog(String(title), String(body), {
    images: imageUrls.length ? imageUrls : undefined,
    tag: tag ? String(tag) : undefined,
    color: typeof color === 'number' ? color : undefined,
  });
  res.json({ ok: true });
});

// Set the Minecraft server(s) a subscriber's managed bots join.
app.put('/api/slots/servers', requireWeb, (req, res) => {
  const sub = getSubscriber(req.web.email);
  if (!sub || !sub.planId) return res.status(403).json({ error: 'no_active_plan' });
  const servers = (req.body?.servers || []).map((s) => String(s).trim()).filter(Boolean);
  if (!servers.length) return res.status(400).json({ error: 'servers required' });
  const updated = setTargetServers(req.web.email, servers);
  supervisor.sync();
  res.json({ servers: updated.targetServers });
});

// Set the Minecraft access token for a specific managed bot slot. Only the
// access token is required — the UUID + username are derived+validated from it.
app.put('/api/slots/:n/token', requireWeb, async (req, res) => {
  const sub = getSubscriber(req.web.email);
  if (!sub || !sub.planId) return res.status(403).json({ error: 'no_active_plan' });
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 0 || n >= sub.botSlots) {
    return res.status(400).json({ error: 'invalid slot index' });
  }
  const { mcAccessToken, mcUuid, mcUsername, mcName, mcProxy, mcVersion } = req.body || {};
  const token = String(mcAccessToken || '').trim();
  if (!token) {
    return res.status(400).json({ error: 'mcAccessToken required' });
  }
  if (token.startsWith('••')) {
    return res.status(400).json({ error: 'enter a new access token' });
  }
  // Validate the token and resolve the profile server-side.
  const v = await validateMinecraftToken(token);
  if (!v.ok) {
    return res.status(400).json({ error: v.message || v.reason });
  }
  const { uuid, username } = v.profile;
  const subscribers = store.subscribers.all();
  sub.mcTokens = sub.mcTokens || [];
  sub.mcTokens[n] = {
    ...(sub.mcTokens[n] || {}),
    mcAccessToken: token,
    mcUuid: uuid,
    // Trust the profile from Minecraft services over whatever was typed.
    mcUsername: username || String(mcUsername || '').trim(),
    mcName: String(mcName || '').trim(),
    mcProxy: String(mcProxy || '').trim(),
    mcVersion: String(mcVersion || '').trim() || 'auto',
  };
  subscribers[req.web.email] = sub;
  store.subscribers.save(subscribers);
  supervisor.sync();
  res.json({ ok: true, slot: n, username: sub.mcTokens[n].mcUsername, uuid });
});

// Per-slot live status + config for the dashboard.
app.get('/api/slots', requireWeb, (req, res) => {
  const sub = getSubscriber(req.web.email);
  if (!sub || !sub.planId) return res.status(403).json({ error: 'no_active_plan' });
  const servers = sub.targetServers || [];
  const mcs = sub.mcTokens || [];
  const status = supervisor.slotStatus(req.web.email);
  const slots = Array.from({ length: sub.botSlots }, (_, n) => ({
    n,
    server: servers[n] || '',
    online: !!(servers[n] && status[servers[n]]),
    hasToken: !!(mcs[n]?.mcAccessToken || mcs[n]?.mcUuid),
    mcUsername: mcs[n]?.mcUsername || '',
    mcName: mcs[n]?.mcName || '',
    mcProxy: mcs[n]?.mcProxy || '',
    mcVersion: mcs[n]?.mcVersion || 'auto',
    config: getSlotConfig(sub, n) || {},
  }));
  res.json({ slots });
});

// Live Minecraft server status for every configured bot slot.
app.get('/api/slots/status', requireWeb, async (req, res) => {
  const sub = getSubscriber(req.web.email);
  if (!sub || !sub.planId) return res.status(403).json({ error: 'no_active_plan' });
  const servers = sub.targetServers || [];
  const status = await pingServers(servers.filter(Boolean));
  res.json({ status });
});

// Monitor a specific slot's Minecraft server in real time.
app.get('/api/slots/:n/status', requireWeb, async (req, res) => {
  const sub = getSubscriber(req.web.email);
  if (!sub || !sub.planId) return res.status(403).json({ error: 'no_active_plan' });
  const n = Number(req.params.n);
  const server = (sub.targetServers || [])[n];
  if (!server) return res.status(400).json({ error: 'no server on this slot' });
  res.json(await pingServer(server));
});

// Deep edit a slot's bot behavior (persona, script, AI, targeting, messaging).
app.put('/api/slots/:n/config', requireWeb, (req, res) => {
  try {
    const sub = getSubscriber(req.web.email);
    if (!sub || !sub.planId) return res.status(403).json({ error: 'no_active_plan' });
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0 || n >= sub.botSlots) {
      return res.status(400).json({ error: 'invalid slot index' });
    }
    // Persist bot metadata (name, proxy, version, discord) in mcTokens
    const meta = req.body?.meta || {};
    if (meta.mcName !== undefined || meta.mcProxy !== undefined || meta.mcVersion !== undefined) {
      sub.mcTokens = sub.mcTokens || [];
      sub.mcTokens[n] = {
        ...(sub.mcTokens[n] || {}),
        mcName: meta.mcName !== undefined ? String(meta.mcName).trim() : (sub.mcTokens[n]?.mcName || ''),
        mcProxy: meta.mcProxy !== undefined ? String(meta.mcProxy).trim() : (sub.mcTokens[n]?.mcProxy || ''),
        mcVersion: meta.mcVersion !== undefined ? String(meta.mcVersion).trim() : (sub.mcTokens[n]?.mcVersion || 'auto'),
      };
      const subscribers = store.subscribers.all();
      subscribers[req.web.email] = sub;
      store.subscribers.save(subscribers);
    }
    const config = setSlotConfig(req.web.email, n, req.body?.config || {});
    supervisor.sync();
    res.json({ ok: true, config });
  } catch (e) {
    res.status(400).json({ error: e.message || 'invalid config' });
  }
});

// Manually boot a single slot's managed bot process.
app.post('/api/slots/:n/start', requireWeb, (req, res) => {
  const sub = getSubscriber(req.web.email);
  if (!sub || !sub.planId) return res.status(403).json({ error: 'no_active_plan' });
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 0 || n >= sub.botSlots) return res.status(400).json({ error: 'invalid slot' });
  const server = (sub.targetServers || [])[n];
  if (!server) return res.status(400).json({ error: 'no server on this slot' });
  const ssid = sub.ssids?.[0] || '';
  const mc = (sub.mcTokens || [])[n] || {};
  const cfg = getSlotConfig(sub, n) || {};
  supervisor.startSlot(sub.email, server, ssid, mc, {
    antiAfk: !!cfg.antiAfk,
    antiAfkInterval: cfg.antiAfkInterval || 120,
  });
  res.json({ ok: true, online: !!supervisor.slotStatus(sub.email)[server] });
});

// Manually stop a single slot's managed bot process.
app.post('/api/slots/:n/stop', requireWeb, (req, res) => {
  const sub = getSubscriber(req.web.email);
  if (!sub || !sub.planId) return res.status(403).json({ error: 'no_active_plan' });
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 0 || n >= sub.botSlots) return res.status(400).json({ error: 'invalid slot' });
  const server = (sub.targetServers || [])[n];
  if (!server) return res.status(400).json({ error: 'no server on this slot' });
  supervisor.stopSlot(`${sub.email}|${server}`);
  res.json({ ok: true });
});

// Start every configured bot slot for this subscriber.
app.post('/api/slots/start-all', requireWeb, (req, res) => {
  const sub = getSubscriber(req.web.email);
  if (!sub || !sub.planId) return res.status(403).json({ error: 'no_active_plan' });
  if (!sub.ssids || sub.ssids.length === 0) return res.status(400).json({ error: 'no_session' });
  const ssid = sub.ssids[0];
  let started = 0;
  (sub.targetServers || []).slice(0, sub.botSlots || 0).forEach((server, i) => {
    if (!server) return;
    if (supervisor.slotStatus(sub.email)[server]) return;
    const mc = (sub.mcTokens || [])[i] || {};
    const cfg = getSlotConfig(sub, i) || {};
    supervisor.startSlot(sub.email, server, ssid, mc, {
      antiAfk: !!cfg.antiAfk,
      antiAfkInterval: cfg.antiAfkInterval || 120,
    });
    started++;
  });
  res.json({ ok: true, started });
});

// Stop every running bot slot for this subscriber.
app.post('/api/slots/stop-all', requireWeb, (req, res) => {
  const sub = getSubscriber(req.web.email);
  if (!sub || !sub.planId) return res.status(403).json({ error: 'no_active_plan' });
  (sub.targetServers || []).forEach((server) => {
    if (!server) return;
    supervisor.stopSlot(`${sub.email}|${server}`);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// Bridge + startup
// ---------------------------------------------------------------
// Start the LTC watcher; on payment, provision the subscription + sync bots.
startWatcher({
  grant: (invoice) => {
    if (invoice.creditKind === 'credits') {
      grantCreditTopup(invoice.email || '', invoice.creditAmount || 0);
      console.log(`[billing] granted ${invoice.creditAmount} credits to ${invoice.email}`);
      return null;
    }
    const sub = grantSubscription(invoice, invoice.email || '');
    console.log(`[billing] granted ${invoice.planId} to ${invoice.email}`);
    supervisor.sync();
    return sub;
  },
  pollMs: Math.max(5000, config.supervisorPollMs || 10_000),
});

// Provision the demo subscriber + reconcile bots in dev.
ensureDemoAccount();
supervisor.sync();

createBotBridge(server, {
  onLeave: (p) => console.log('[bridge] bot session ended', p?.email),
});

// Resume records created through /api/bots after a process restart. The
// manager staggers connections so a Railway redeploy does not hammer the
// Minecraft services API all at once.
void resumeEnabledBots();

// Sweep paid invoice balances into the owner wallet (boot + 5 min cycle).
startOwnerSweeper();

// Auto-cancel stale pending invoices once on boot.
cancelStaleInvoices();

// Expire lapsed (custom-duration) subscriptions: boot + every 10 minutes.
function expireAndSync() {
  const n = expireLapsedSubscribers();
  if (n) supervisor.sync();
}
expireAndSync();
setInterval(expireAndSync, 10 * 60 * 1000);

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[abeam] dashboard + api listening on http://0.0.0.0:${config.port}`);
  if (config.allowDemo) console.log(`[abeam] demo ssid: ${config.demoSsid}`);
});
