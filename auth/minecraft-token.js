// Validate a Minecraft access token against Mojang/Minecraft services and
// derive the profile (username + UUID). The operator only needs to paste the
// access token — the UUID and username are resolved automatically.

const MS_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

const FETCH_TIMEOUT_MS = 8000;

function fetchJson(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function uuidWithoutDashes(uuid) {
  return String(uuid || '').replace(/-/g, '').toLowerCase();
}

/** Probe the Minecraft services profile endpoint, which validates the bearer token. */
async function profileFromMinecraftServices(token) {
  const res = await fetchJson(MS_PROFILE_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || !data.id || !data.name) return null;
  return { uuid: uuidWithoutDashes(data.id), username: data.name };
}

/**
 * Validate a Minecraft bearer access token and return its profile.
 * Returns `{ ok: true, profile }` on success or `{ ok: false, reason }`.
 */
export async function validateMinecraftToken(token) {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'access_token_required' };
  }
  const clean = token.trim();
  if (clean.length < 10) return { ok: false, reason: 'token_too_short' };

  const profile = await profileFromMinecraftServices(clean);
  if (!profile) {
    return {
      ok: false,
      reason: 'invalid_or_expired',
      message: 'This access token is not valid — it may be expired or not a Minecraft bearer token.',
    };
  }
  return { ok: true, profile };
}