import crypto from 'node:crypto';
import { store } from '../store/index.js';

/**
 * Signed, store-backed web sessions for the dashboard (Discord OAuth).
 * The cookie holds a random session id; the session record holds the user.
 */
const SESSION_COOKIE = 'abeam_session';
const MAX_AGE = 1000 * 60 * 60 * 24 * 7; // 7 days

export function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function createSession(secret, user, res) {
  const sid = crypto.randomBytes(24).toString('hex');
  const sessions = store.sessions.all();
  sessions[sid] = {
    user,
    createdAt: Date.now(),
    expiresAt: Date.now() + MAX_AGE,
  };
  store.sessions.save(sessions);
  const cookie = `${SESSION_COOKIE}=${sid}.${sign(sid, secret)}; HttpOnly; Path=/; Max-Age=${Math.floor(MAX_AGE / 1000)}; SameSite=Lax`;
  res.setHeader('Set-Cookie', cookie);
  return sid;
}

export function destroySession(secret, req, res) {
  const sid = getSid(req);
  if (sid) {
    const sessions = store.sessions.all();
    delete sessions[sid];
    store.sessions.save(sessions);
  }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function getSid(req) {
  const header = req.headers['cookie'] || '';
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === SESSION_COOKIE && v) return v;
  }
  return null;
}

export function getSessionUser(req, secret) {
  const raw = getSid(req);
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const sid = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (sign(sid, secret) !== sig) return null;
  const sessions = store.sessions.all();
  const rec = sessions[sid];
  if (!rec || rec.expiresAt < Date.now()) return null;
  return rec.user;
}
