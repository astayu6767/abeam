import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { store } from '../store/index.js';
import { getSlotConfig, isSubExpired } from '../billing/subscribers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', '..', 'data', 'bots');

/**
 * Fully-managed cloud bots: each active subscription owns up to `botSlots`
 * dedicated azalea (abeam.exe) processes, one per configured Minecraft server.
 * A slot is keyed by `email|server`.
 *
 * Each slot may carry a direct Minecraft access token + UUID (the online-mode
 * "minecraft access token login"). If a slot has no token configured we still
 * boot it in offline mode so the operator can test against a local server.
 */
export class BotSupervisor {
  constructor() {
    this.slots = new Map(); // key -> { proc, email, server, startedAt }
  }

  logPath(email, server) {
    const safe = email.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dir = path.join(LOG_DIR, safe);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${server.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`);
  }

  /**
   * @param {string} email
   * @param {string} server
   * @param {string} ssid  backend access token (Authorization to our WS)
   * @param {{mcAccessToken?:string, mcUuid?:string, mcUsername?:string}} [mc]
   */
  startSlot(email, server, ssid, mc, opts = {}) {
    const key = `${email}|${server}`;
    if (this.slots.has(key)) return;

    if (!config.botExe || !fs.existsSync(config.botExe)) {
      console.warn(`[supervisor] BOT_EXE not configured (${config.botExe}) — not starting slot ${key}`);
      return;
    }

    const logFile = this.logPath(email, server);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    const username = mc?.mcUsername || 'cloubot' + Math.abs(requireLogic() % 1e6);

    const args = slotArgs(email, server, { ...(mc || {}), mcUsername: mc?.mcUsername || username }, ssid, opts);

    const proc = spawn(config.botExe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    proc.stdout.pipe(logStream);
    proc.stderr.pipe(logStream);
    proc.on('error', (e) => logStream.write(`[supervisor] spawn error: ${e.message}\n`));
    proc.on('exit', (code) => {
      logStream.write(`[supervisor] process exited (${code})\n`);
      this.slots.delete(key);
    });

    this.slots.set(key, { proc, email, server, startedAt: Date.now(), logFile });
    console.log(`[supervisor] started slot ${key} (${username}) (log: ${logFile})`);
  }

  stopSlot(keyOrEmail) {
    const key = keyOrEmail.includes('|') ? keyOrEmail : [...this.slots.keys()].find((k) => k.startsWith(keyOrEmail + '|'));
    if (!key) return;
    const slot = this.slots.get(key);
    if (slot) {
      try { slot.proc.kill(); } catch {}
      this.slots.delete(key);
      console.log(`[supervisor] stopped slot ${key}`);
    }
  }

  slotStatus(email) {
    const out = {};
    for (const [key, slot] of this.slots) {
      if (!key.startsWith(email + '|')) continue;
      out[key.split('|')[1]] = { running: true, startedAt: slot.startedAt, logFile: slot.logFile };
    }
    return out;
  }

  /** Reconcile running slots against active subscriptions & config. */
  sync() {
    const desired = new Set();
    const subscribers = store.subscribers.all();

    // Stop slots no longer desired (plan downgraded / server removed / expired).
    for (const key of [...this.slots.keys()]) {
      let keep = false;
      for (const sub of Object.values(subscribers)) {
        if (!sub || sub.status !== 'active' || !sub.planId) continue;
        if (isSubExpired(sub)) continue;
        if ((sub.targetServers || []).includes(key.split('|')[1])) { keep = true; break; }
      }
      if (!keep) this.stopSlot(key);
    }

    // Start missing slots, passing the per-slot Minecraft token when available.
    for (const sub of Object.values(subscribers)) {
      if (!sub || !sub.planId || !sub.botSlots || sub.status !== 'active') continue;
      if (isSubExpired(sub)) continue;
      if (!sub.ssids || sub.ssids.length === 0) continue;
      const ssid = sub.ssids[0];
      const servers = (sub.targetServers || []).slice(0, sub.botSlots);
      servers.forEach((server, i) => {
        desired.add(`${sub.email}|${server}`);
        const mc = (sub.mcTokens || [])[i];
        const cfg = getSlotConfig(sub, i) || {};
        this.startSlot(sub.email, server, ssid, mc, {
          antiAfk: !!cfg.antiAfk,
          antiAfkInterval: cfg.antiAfkInterval || 120,
        });
      });
    }
    return desired;
  }

  stopAll() {
    for (const key of [...this.slots.keys()]) this.stopSlot(key);
  }
}

/** Slot key: `email|server`. */
export const slotId = (email, server) => `${email}|${server}`;

/** Build the abeam.exe argument list for a slot. Pure + testable. */
export function slotArgs(email, server, mc = {}, ssid = '', opts = {}) {
  const args = [
    '--backend', config.backendWsUrl,
    '--server', server,
    '--ssid', ssid,
    '--slot-id', slotId(email, server),
    '--mode', 'sword',
  ];
  if (mc?.mcAccessToken && mc?.mcUuid) {
    args.push('--mc-access-token', mc.mcAccessToken, '--mc-uuid', mc.mcUuid);
  }
  args.push('--username', mc?.mcUsername || 'cloubot' + Math.abs(requireLogic() % 1e6));
  if (opts.antiAfk) {
    args.push('--anti-afk', 'true', '--anti-afk-interval', String(opts.antiAfkInterval || 120));
  }
  return args;
}

function requireLogic() {
  // tiny deterministic-ish int for a unique-ish username
  return (Date.now() % 100000) * 17;
}
