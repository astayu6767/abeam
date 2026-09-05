import crypto from 'node:crypto';

// Cheap in-memory token store (plus persistence via the file store).
// In production, store hashes in a database and rotate regularly.

let tokens = new Map(); // ssid -> { email, issuedAt, expiresAt }

export function resetTokenCache() {
  tokens = new Map();
}

/**
 * Create an access token ("SSID") for an email.
 * Returns the plaintext token (shown once to the user).
 */
export function createToken(email, ttlMs = 1000 * 60 * 60 * 24 * 30) {
  const ssid = crypto.randomBytes(24).toString('hex');
  tokens.set(ssid, {
    email,
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  });
  return ssid;
}

/** Validate an SSID; returns { email } or null. */
export function validateToken(ssid) {
  if (!ssid) return null;
  const t = tokens.get(ssid);
  if (!t) return null;
  if (t.expiresAt < Date.now()) {
    tokens.delete(ssid);
    return null;
  }
  return { email: t.email };
}

export function revokeToken(ssid) {
  tokens.delete(ssid);
}

/**
 * Load static/demo SSIDs from config so a user can log in immediately even
 * before Discord OAuth is configured.
 */
export function upsertStaticToken(ssid, email) {
  if (ssid && email) {
    tokens.set(ssid, {
      email,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 365,
    });
  }
}

/** HTTP-friendly: resolve "Bearer <ssid>" header. */
export function tokenFromHeader(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return req.headers['x-ssid'] || '';
}
