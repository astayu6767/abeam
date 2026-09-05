import { config } from './config.js';

/** True when a web-session user holds operator privileges. */
export function isAdminUser(user) {
  const u = user || {};
  const email = String(u.email || '').trim().toLowerCase();
  const did = String(u.discordId || '').trim();
  return u.role === 'admin' || config.adminEmails.includes(email) || config.adminDiscordIds.includes(did);
}