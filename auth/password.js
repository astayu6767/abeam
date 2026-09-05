import crypto from 'node:crypto';
import { store } from '../store/index.js';

// Email/password accounts. Passwords are stored as salted PBKDF2-SHA512
// hashes with a per-user random salt and iteration count; verification uses
// timingSafeEqual to avoid leaking hash equality.

const DEFAULT_ITER = 120000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, DEFAULT_ITER, 64, 'sha512');
  return { salt, iter: DEFAULT_ITER, hash: hash.toString('hex') };
}

function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const got = crypto.pbkdf2Sync(password, rec.salt, rec.iter || DEFAULT_ITER, 64, 'sha512');
  const expected = Buffer.from(rec.hash, 'hex');
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function getPasswordUser(email) {
  return store.passwords.all()[normalizeEmail(email)] || null;
}

export function setPasswordUser(email, password) {
  const all = store.passwords.all();
  const emailKey = normalizeEmail(email);
  all[emailKey] = {
    email: emailKey,
    createdAt: Date.now(),
    ...hashPassword(password),
  };
  store.passwords.save(all);
  return all[emailKey];
}

export function checkLogin(email, password) {
  const key = normalizeEmail(email);
  const rec = getPasswordUser(key);
  if (!rec) return null;
  if (!verifyPassword(password || '', rec)) return null;
  return { email: key, username: key.split('@')[0], via: 'password' };
}