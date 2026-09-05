import crypto from 'node:crypto';
import { store } from '../store/index.js';
import { planById } from '../plans.js';
import { grantSubscription } from './subscribers.js';

const GROUPS = 4;
const GROUP_LEN = 4;

/** Turn 2 bytes of hex into an uppercase alphanumeric group (no O/0/I/1). */
function groupFromHex(hex) {
  const n = parseInt(hex, 16);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  let v = n;
  for (let i = 0; i < GROUP_LEN; i++) {
    out = alphabet[v % alphabet.length] + out;
    v = Math.floor(v / alphabet.length);
  }
  return out;
}

/** Validate both the original serial format and the reference UI's key form. */
export function validateLicenseCode(code) {
  const value = String(code || '').trim();
  return /^ABEAM-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(value)
    || /^abeam-key-[a-z0-9-]{8,80}$/i.test(value);
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** Clamp duration to a sane 0..120 months (0 = lifetime). */
export function clampMonths(months) {
  const n = Number(months);
  if (!Number.isFinite(n)) return 0;
  return Math.min(120, Math.max(0, Math.round(n)));
}

/** Generate and persist a fresh one-time license key for a plan.
 *  `months` = subscription duration on redemption (0 = lifetime). */
export function generateLicenseKey(planId, createdBy, months = 0) {
  if (!planById(planId)) throw new Error('plan no longer exists');
  const code = `abeam-key-${crypto.randomBytes(12).toString('hex')}`;
  const keys = store.licenses.all();
  keys.push({
    code,
    planId,
    months: clampMonths(months),
    created: Date.now(),
    createdBy: createdBy || null,
    redeemedBy: null,
    redeemedAt: null,
  });
  store.licenses.save(keys);
  return code;
}

/** Redeem a one-time key, granting its plan to `email` for its duration. */
export function redeemLicenseKey(code, email) {
  if (!validateLicenseCode(code)) return { ok: false, reason: 'invalid_code' };
  const keys = store.licenses.all();
  const key = keys.find((k) => k.code === code);
  if (!key) return { ok: false, reason: 'invalid_code' };
  if (key.redeemedAt) return { ok: false, reason: 'already_redeemed' };
  key.redeemedBy = email;
  key.redeemedAt = Date.now();
  store.licenses.save(keys);
  const { subscriber: granted } = grantSubscription({ planId: key.planId, months: key.months }, email);
  let subscriber = granted;
  const hasCustomDuration = key.durationDays !== undefined || key.durationHours !== undefined;
  if (hasCustomDuration || key.requestedSlots !== undefined) {
    const all = store.subscribers.all();
    subscriber = {
      ...granted,
      botSlots: Number(key.requestedSlots || granted.botSlots),
      expiresAt: Number(key.durationDays || 0) || Number(key.durationHours || 0)
        ? Date.now() + (Number(key.durationDays || 0) * 24 + Number(key.durationHours || 0)) * 3_600_000
        : null,
    };
    all[email] = subscriber;
    store.subscribers.save(all);
  }
  const durationDays = hasCustomDuration
    ? Math.max(0, Number(key.durationDays || 0))
    : Math.floor(Math.max(0, Number(key.months || 0) * 30));
  const durationHours = hasCustomDuration
    ? Math.max(0, Number(key.durationHours || 0))
    : Math.max(0, Math.round(Number(key.months || 0) * 30 * 24)) % 24;
  return {
    ok: true,
    planId: key.planId,
    months: key.months,
    subscriber,
    license: {
      slots: subscriber.botSlots,
      durationDays,
      durationHours,
      expiresAt: subscriber.expiresAt || null,
      licenseKey: key.code,
    },
  };
}

/** List keys, optionally filtered by plan (newest first). */
export function listLicenseKeys(planId) {
  const keys = store.licenses.all();
  const filtered = planId ? keys.filter((k) => k.planId === planId) : keys;
  return [...filtered].reverse();
}
