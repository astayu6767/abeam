import { store } from '../store/index.js';
import { planById } from '../plans.js';
import { createToken, validateToken } from '../auth/ssid.js';
import { config } from '../config.js';
import { mergeConfig } from '../conversation/presets.js';

/**
 * Grant a subscription to an email after a successful payment or key redeem.
 * Creates a fresh SSID (shown to the buyer once) and allocates the plan's bot
 * slots. `invoice.months` sets a duration (0/lifetime by default). Returns
 * { subscriber, ssid }.
 */
export function grantSubscription(invoice, email) {
  const plan = planById(invoice.planId);
  if (!plan) throw new Error('plan no longer exists');

  const subscribers = store.subscribers.all();
  const sub = subscribers[email] || {
    email,
    planId: null,
    botSlots: 0,
    ssids: [],
    targetServers: [],
    since: null,
    expiresAt: null,
  };

  sub.planId = plan.id;
  sub.botSlots = plan.botSlots;
  sub.since = Date.now();
  sub.status = 'active';
  sub.expiresAt = Number(invoice.months) > 0 ? Date.now() + Number(invoice.months) * 30 * 24 * 60 * 60 * 1000 : null;

  const ssid = createToken(email, 1000 * 60 * 60 * 24 * 365); // 1yr
  sub.ssids.push(ssid);

  subscribers[email] = sub;
  store.subscribers.save(subscribers);
  return { subscriber: sub, ssid };
}

export function getSubscriber(email) {
  return store.subscribers.all()[email] || null;
}

/**
 * Operator-only: apply a management patch to a subscriber record.
 * Supports planId, botSlots, status, demo, trial, since. Throws on invalid
 * input so the HTTP layer can 400. Does NOT touch credits (see credits.js).
 */
export function patchSubscriber(email, patch = {}) {
  const all = store.subscribers.all();
  const sub = all[email];
  if (!sub) throw new Error('no_such_subscriber');
  if (patch.planId !== undefined) {
    const plan = patch.planId ? planById(String(patch.planId)) : null;
    if (patch.planId && !plan) throw new Error('invalid_plan');
    sub.planId = plan ? plan.id : null;
    sub.planName = plan ? plan.name : null;
    if (patch.botSlots === undefined) sub.botSlots = plan ? plan.botSlots : 0;
    if (patch.status === undefined) sub.status = plan ? 'active' : 'revoked';
  }
  if (patch.botSlots !== undefined) {
    const n = Number(patch.botSlots);
    if (!Number.isInteger(n) || n < 0 || n > 50) throw new Error('invalid_slot_count');
    sub.botSlots = n;
  }
  if (patch.status !== undefined) sub.status = String(patch.status).trim() || 'inactive';
  if (patch.demo !== undefined) sub.demo = !!patch.demo;
  if (patch.trial !== undefined) sub.trial = !!patch.trial;
  if (patch.since !== undefined && patch.since != null && !Number.isNaN(Number(patch.since))) {
    sub.since = Number(patch.since);
  }
  all[email] = sub;
  store.subscribers.save(all);
  return sub;
}

/** True when a subscriber record has lapsed its custom duration. */
export function isSubExpired(sub) {
  return !!sub && typeof sub.expiresAt === 'number' && sub.expiresAt <= Date.now();
}

/** Flip lapsed subscribers to status 'expired' so the UI paints them clearly.
 *  Returns the count changed. Legal the store is a plain keyed object. */
export function expireLapsedSubscribers() {
  const all = store.subscribers.all();
  let changed = 0;
  for (const sub of Object.values(all)) {
    if (isSubExpired(sub) && sub.status !== 'expired') {
      sub.status = 'expired';
      changed++;
    }
  }
  if (changed) {
    store.subscribers.save(all);
    console.log(`[billing] expired ${changed} subscription(s)`);
  }
  return changed;
}

export function isActiveSubscriber(email) {
  const sub = getSubscriber(email);
  if (isSubExpired(sub)) return false;
  return !!sub && !!sub.planId && !!sub.botSlots;
}

/** Set the Minecraft server(s) a subscriber wants their managed bots to join.
 *  No cap — a license can point its bots at any server(s) it wants. */
export function setTargetServers(email, servers) {
  const subscribers = store.subscribers.all();
  const sub =
    subscribers[email] ||
    { email, planId: null, botSlots: 0, ssids: [], targetServers: [], since: null };
  sub.targetServers = [...new Set((servers || []).map((s) => s.trim()).filter(Boolean))];
  subscribers[email] = sub;
  store.subscribers.save(subscribers);
  return sub;
}

/** Describe entitlement from a raw Authorization Bearer value. */
export function accountForBearer(bearer) {
  const claim = validateToken(bearer);
  if (!claim) return { ok: false, reason: 'invalid_token' };

  const demoOk =
    config.allowDemo &&
    (claim.email === config.demoEmail || bearer === config.demoSsid);

  const hasPlan = isActiveSubscriber(claim.email);
  if (!hasPlan && !demoOk) {
    return { ok: false, reason: 'no_active_plan', email: claim.email };
  }
  return { ok: true, email: claim.email, subscriber: hasPlan ? getSubscriber(claim.email) : null };
}

/** Provision (or re-provision) the demo account when allowed. */
export function ensureDemoAccount() {
  if (!config.allowDemo) return;
  const subscribers = store.subscribers.all();
  if (subscribers[config.demoEmail]) return;
  subscribers[config.demoEmail] = {
    email: config.demoEmail,
    planId: 'raid',
    botSlots: 4,
    ssids: [config.demoSsid],
    targetServers: ['localhost'],
    mcTokens: [],
    configs: [],
    since: Date.now(),
    status: 'active',
    demo: true,
  };
  store.subscribers.save(subscribers);
}

/**
 * Dev/demo: grant a new email/password signup the starter plan so the full
 * dashboard can be explored without paying. Never active in production.
 */
export function ensureLocalTrial(email) {
  if (!config.allowDemo || process.env.NODE_ENV === 'production') return false;
  const subscribers = store.subscribers.all();
  if (subscribers[email]) return false;
  subscribers[email] = {
    email,
    planId: 'raid',
    botSlots: 4,
    ssids: [],
    targetServers: ['localhost'],
    mcTokens: [],
    configs: [null, null, null, null],
    since: Date.now(),
    status: 'active',
    trial: true,
  };
  store.subscribers.save(subscribers);
  return true;
}

const CONFIG_KEYS = ['persona', 'script', 'scriptLines', 'ai', 'targeting', 'messaging', 'antiAfk', 'antiAfkInterval', 'logging'];

/** Return the stored (raw) config for slot `n`, or null. */
export function getSlotConfig(sub, n) {
  return (sub?.configs || [])[n] || null;
}

/** Validate + persist a per-slot bot config. Throws on bad slot index. */
export function setSlotConfig(email, n, config) {
  const sub = getSubscriber(email);
  if (!sub || !sub.planId) throw new Error('no_active_plan');
  if (!Number.isInteger(n) || n < 0 || n >= sub.botSlots) {
    throw new Error('invalid slot index');
  }
  const clean = Object.fromEntries(
    Object.entries(config || {}).filter(([k]) => CONFIG_KEYS.includes(k)),
  );
  sub.configs = sub.configs || [];
  sub.configs[n] = clean;
  const all = store.subscribers.all();
  all[email] = sub;
  store.subscribers.save(all);
  return getSlotConfig(sub, n);
}

/**
 * Resolve the fully-merged, runnable config for a slot, given the slotId
 * (`email|server`). Used by the bridge when a bot logs in for that slot.
 */
export function buildBotConfig(email, slotId) {
  const sub = getSubscriber(email);
  if (!sub) return mergeConfig({});
  const server = (slotId || '').split('|')[1] || '';
  const n = (sub.targetServers || []).indexOf(server);
  const raw = n >= 0 ? getSlotConfig(sub, n) : null;
  return mergeConfig(raw || {});
}

/**
 * Produce the stable account key for a web user (email, or discord:<id> when
 * Discord omits a verified email). The subscriber store is keyed by this.
 */
export function resolveAccountKey(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (email && (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.startsWith('local:'))) return email;
  if (user?.discordId) return `discord:${String(user.discordId)}`;
  return `anon:${Date.now()}`;
}
