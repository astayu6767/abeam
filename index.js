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
import { checkLogin, setPasswordUser, normalizeEmail } from './auth/password.js';
import {
  createInvoice,
  getInvoice,
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);

function isAdmin(user) {
  return isAdminUser(user);
}

app.use(cors({ origin: config.appUrl, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

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
  const email = (req.body?.email || '').toString().trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'valid email required' });
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
app.post('/api/auth/signup', (req, res) => {
  const { email, password } = req.body || {};
  const key = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  if (checkLogin(key, password)) {
    return res.status(409).json({ error: 'email already has an account — try signing in' });
  }
  setPasswordUser(key, password);
  ensureLocalTrial(key);
  const user = { email: key, username: key.split('@')[0], via: 'password' };
  createSession(config.sessionSecret, user, res);
  res.json({ ok: true, email: key });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = checkLogin(email, password);
  if (!user) {
    return res.status(401).json({ error: 'wrong email or password' });
  }
  createSession(config.sessionSecret, user, res);
  res.json({ ok: true, email: user.email });
});

// ---------------------------------------------------------------
// Discord OAuth (website login)
// ---------------------------------------------------------------
const DISCORD_AUTH_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';

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
// (or pending) for their account.
app.get('/api/licenses', requireWeb, (req, res) => {
  const invoices = store.invoices
    .all()
    .filter((i) => i.email === req.web.email)
    .reverse();
  const sub = getSubscriber(req.web.email);
  res.json({
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
  const code = String(req.body?.code || '').toUpperCase().trim();
  const email = req.web.email;
  if (!code) return res.status(400).json({ error: 'code_required' });
  const result = redeemLicenseKey(code, email);
  if (!result.ok) return res.status(400).json({ error: result.reason });
  if (typeof supervisor?.sync === 'function') supervisor.sync();
  return res.json({ ok: true, planId: result.planId, subscriber: result.subscriber });
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
        key,
        email: sub?.email || u.email || null,
        username: u.username || null,
        discordId: u.discordId || null,
        via: u.via || (u.discordId ? 'discord' : 'backend'),
        created: u.created || u.since || null,
        admin: isAdmin(u),
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

server.listen(config.port, () => {
  console.log(`[abeam] dashboard + api listening on http://localhost:${config.port}`);
  if (config.allowDemo) console.log(`[abeam] demo ssid: ${config.demoSsid}`);
});
