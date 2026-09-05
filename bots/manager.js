import crypto from 'node:crypto';
import { store } from '../store/index.js';
import { config } from '../config.js';
import { validateMinecraftToken } from '../auth/minecraft-token.js';
import { buildBotConfig } from '../billing/subscribers.js';
import { consumeAiCredit } from '../billing/credits.js';
import { newConversation, step, rephraseScriptedLine } from '../conversation/index.js';
import { postMatchStart } from '../webhook/index.js';
import { startAzaleaBot, stopAzaleaBot } from './azalea.js';

/**
 * Bot manager for bots created through the HTTP API.
 *
 * This follows the useful part of mc-bot-manager's botManager: a bot is a
 * persisted record plus an in-memory runtime. The record survives a restart;
 * the runtime owns the Azalea sidecar connection, logs, beam conversations and
 * control actions. Minecraft access tokens never leave this module in API
 * responses. Mineflayer remains available only as an optional local fallback.
 *
 * The older `/api/slots` API in this repository still manages the external
 * abeam executable through bots/supervisor.js. These APIs are the self-contained
 * create/start/stop APIs and default to the compiled Azalea Rust client.
 */

const MAX_LOGS = 300;
const MAX_RECONNECTS = 8;
const BOT_STATUS = new Set(['offline', 'connecting', 'online', 'error']);

const globalState = globalThis;
const runtimes = globalState.__abeamBotRuntimes || new Map();
globalState.__abeamBotRuntimes = runtimes;

let resumeStarted = false;

function now() {
  return Date.now();
}

function asString(value, fallback = '') {
  return value == null ? fallback : String(value);
}

function clampText(value, max, fallback = '') {
  return asString(value, fallback).trim().slice(0, max);
}

function normalizeOwner(email) {
  return asString(email).trim().toLowerCase();
}

function allBots() {
  const rows = store.bots.all();
  return Array.isArray(rows) ? rows : [];
}

function saveBots(rows) {
  store.bots.save(Array.isArray(rows) ? rows : []);
}

function findStoredBot(id) {
  return allBots().find((bot) => bot.id === id) || null;
}

function patchStoredBot(id, patch) {
  const rows = allBots();
  const index = rows.findIndex((bot) => bot.id === id);
  if (index < 0) return null;
  rows[index] = { ...rows[index], ...patch };
  saveBots(rows);
  return rows[index];
}

function isEnabled(record) {
  return record?.enabled === true || record?.enabled === 'true';
}

function publicProxy(raw) {
  const value = asString(raw).trim();
  if (!value) return '';
  // Do not expose proxy credentials in list/detail responses.
  try {
    const url = new URL(value.includes('://') ? value : `socks5://${value}`);
    if (url.username || url.password) {
      url.username = url.username ? '••••' : '';
      url.password = url.password ? '••••' : '';
      return url.toString();
    }
  } catch {
    // Keep malformed values masked rather than echoing them verbatim.
    return '[configured]';
  }
  return value;
}

function runtimeFor(id) {
  let runtime = runtimes.get(id);
  if (!runtime) {
    runtime = {
      id,
      status: 'offline',
      joined: false,
      lastError: null,
      logs: [],
      bot: null,
      profile: null,
      manualStop: false,
      connectionTimeout: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      antiAfkTimer: null,
      azaleaChild: null,
      azaleaSnap: null,
      azaleaHbWatcher: null,
      azaleaHbAt: 0,
      azaleaHbTickAgeS: null,
      azaleaHbOnline: false,
      azaleaRespawn: false,
      azaleaLastRestart: 0,
      beamTimer: null,
      beamBusy: false,
      beamEnabled: false,
      beamTarget: null,
      conversations: new Map(),
    };
    runtimes.set(id, runtime);
  }
  return runtime;
}

function log(runtime, level, line) {
  const text = clampText(line, 1000);
  if (!text) return;
  runtime.logs.push({ ts: now(), level, line: text });
  if (runtime.logs.length > MAX_LOGS) {
    runtime.logs.splice(0, runtime.logs.length - MAX_LOGS);
  }
}

function persistStatus(id, status, lastError = null, extra = {}) {
  if (!BOT_STATUS.has(status)) status = 'error';
  return patchStoredBot(id, {
    status,
    lastError: lastError ? clampText(lastError, 1000) : null,
    ...extra,
  });
}

function publicBot(record) {
  if (!record) return null;
  const runtime = runtimes.get(record.id);
  const status = runtime?.status || record.status || 'offline';
  return {
    id: record.id,
    name: record.name,
    ownerEmail: record.ownerEmail,
    username: record.username || null,
    uuid: record.uuid || null,
    host: record.host,
    port: record.port,
    version: record.version || 'auto',
    proxy: publicProxy(record.proxy),
    proxyConfigured: !!String(record.proxy || '').trim(),
    hasToken: !!String(record.token || '').trim(),
    ytChannel: record.ytChannel,
    beamIp: record.beamIp,
    discordUser: record.discordUser,
    minecraftUsername: record.minecraftUsername || null,
    aiRephrasing: record.aiRephrasing !== false,
    beamLogging: record.beamLogging === true,
    webhookConfigured: !!String(record.discordWebhook || '').trim(),
    engine: record.engine || 'azalea',
    beamType: record.beamType || 'ai',
    spamMessage: record.spamMessage,
    spamInterval: record.spamInterval,
    spamTriggerWord: record.spamTriggerWord,
    spamReplyMessage: record.spamReplyMessage,
    openerScript: record.openerScript,
    antiAfk: record.antiAfk === true || record.antiAfk === 'true',
    status,
    joined: !!runtime?.joined,
    enabled: isEnabled(record),
    lastError: runtime?.lastError ?? record.lastError ?? null,
    createdAt: record.createdAt,
  };
}

function parseHostAndPort(rawHost, rawPort, fallbackPort = 25565) {
  let host = clampText(rawHost, 253);
  let port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) port = fallbackPort;

  // Bracketed IPv6: [2001:db8::1]:25565
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end > 0) {
      const bracketHost = host.slice(1, end);
      const suffix = host.slice(end + 1);
      if (suffix.startsWith(':')) {
        const candidate = Number(suffix.slice(1));
        if (Number.isInteger(candidate) && candidate > 0 && candidate < 65536) port = candidate;
      }
      host = bracketHost;
    }
    return { host, port };
  }

  // Only treat the last colon as a port delimiter when the address is not an
  // unbracketed IPv6 literal.
  const colonCount = (host.match(/:/g) || []).length;
  const colon = host.lastIndexOf(':');
  if (colon > 0 && colonCount === 1) {
    const candidate = Number(host.slice(colon + 1));
    if (Number.isInteger(candidate) && candidate > 0 && candidate < 65536) {
      host = host.slice(0, colon);
      port = candidate;
    }
  }
  return { host, port };
}

function normalizeBotInput(input = {}, existing = {}) {
  const parsed = parseHostAndPort(
    input.host !== undefined ? input.host : existing.host,
    input.port !== undefined ? input.port : existing.port,
    existing.port || 25565,
  );
  if (!parsed.host || /[\u0000-\u001f\u007f]/.test(parsed.host)) {
    throw new Error('a valid Minecraft server address is required');
  }

  const engine = input.engine ?? existing.engine ?? 'azalea';
  if (!['azalea', 'mineflayer'].includes(engine)) {
    throw new Error('engine must be "azalea" or "mineflayer"');
  }

  const token = input.token !== undefined
    ? clampText(input.token, 4096)
    : asString(existing.token);
  if (!token) throw new Error('a Minecraft access token is required');

  return {
    name: clampText(input.name !== undefined ? input.name : existing.name, 80, parsed.host) || parsed.host,
    token,
    host: parsed.host,
    port: parsed.port,
    version: clampText(input.version !== undefined ? input.version : existing.version, 32, 'auto') || 'auto',
    proxy: clampText(input.proxy !== undefined ? input.proxy : existing.proxy, 512),
    minecraftUsername: clampText(input.minecraftUsername !== undefined ? input.minecraftUsername : existing.minecraftUsername, 128),
    discordWebhook: clampText(input.discordWebhook !== undefined ? input.discordWebhook : existing.discordWebhook, 1024),
    aiRephrasing: input.aiRephrasing !== undefined ? !!input.aiRephrasing : existing.aiRephrasing !== false,
    beamLogging: input.beamLogging !== undefined ? !!input.beamLogging : existing.beamLogging === true,
    ytChannel: clampText(input.ytChannel !== undefined ? input.ytChannel : existing.ytChannel, 128, 'Alight.z') || 'Alight.z',
    beamIp: clampText(input.beamIp !== undefined ? input.beamIp : existing.beamIp, 253, 'badlion-pvp.xyz') || 'badlion-pvp.xyz',
    discordUser: clampText(input.discordUser !== undefined ? input.discordUser : existing.discordUser, 128, 'stood014') || 'stood014',
    engine,
    // Azalea is the production/default engine. Mineflayer is retained for
    // local compatibility when explicitly requested by an operator.
    beamType: ['ai', 'spam', 'lobby'].includes(input.beamType ?? existing.beamType)
      ? (input.beamType ?? existing.beamType)
      : 'ai',
    spamMessage: clampText(input.spamMessage !== undefined ? input.spamMessage : existing.spamMessage, 256, 'join my smp guys /msg me'),
    spamInterval: Math.max(1000, Math.min(86_400_000, Number.isFinite(Number(input.spamInterval ?? existing.spamInterval)) ? Number(input.spamInterval ?? existing.spamInterval) : 60_000)),
    spamTriggerWord: clampText(input.spamTriggerWord !== undefined ? input.spamTriggerWord : existing.spamTriggerWord, 80, '123') || '123',
    spamReplyMessage: clampText(input.spamReplyMessage !== undefined ? input.spamReplyMessage : existing.spamReplyMessage, 256, 'add my discord stood014 to join'),
    openerScript: clampText(input.openerScript !== undefined ? input.openerScript : existing.openerScript, 4000),
    antiAfk: input.antiAfk !== undefined
      ? !!input.antiAfk
      : existing.antiAfk === true || existing.antiAfk === 'true',
    antiAfkInterval: Math.max(15, Math.min(3600, Number(input.antiAfkInterval ?? existing.antiAfkInterval) || 120)),
  };
}

export function countBots(ownerEmail) {
  const owner = normalizeOwner(ownerEmail);
  return allBots().filter((bot) => normalizeOwner(bot.ownerEmail) === owner).length;
}

export function getBot(id) {
  return findStoredBot(id);
}

export function listBots(ownerEmail, includeAll = false) {
  const owner = normalizeOwner(ownerEmail);
  return allBots()
    .filter((bot) => includeAll || normalizeOwner(bot.ownerEmail) === owner)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .map(publicBot);
}

export function createBot(ownerEmail, input = {}) {
  const normalized = normalizeBotInput(input);
  const record = {
    id: crypto.randomUUID(),
    ownerEmail: normalizeOwner(ownerEmail),
    ...normalized,
    username: null,
    uuid: null,
    status: 'offline',
    lastError: null,
    enabled: 'false',
    createdAt: now(),
  };
  const rows = allBots();
  rows.push(record);
  saveBots(rows);
  return record;
}

export function updateBotRecord(id, input = {}) {
  const existing = findStoredBot(id);
  if (!existing) throw new Error('bot not found');
  const updates = normalizeBotInput(input, existing);
  const updated = patchStoredBot(id, updates);
  return updated;
}

export function getRuntimeView(id) {
  const record = findStoredBot(id);
  const runtime = runtimes.get(id);
  return {
    status: runtime?.status || record?.status || 'offline',
    joined: !!runtime?.joined,
    lastError: runtime?.lastError ?? record?.lastError ?? null,
  };
}

export function getLogs(id) {
  return [...(runtimes.get(id)?.logs || [])];
}

function clearTimer(runtime, key) {
  if (runtime[key]) {
    clearTimeout(runtime[key]);
    clearInterval(runtime[key]);
    runtime[key] = null;
  }
}

function stopAntiAfk(runtime) {
  clearTimer(runtime, 'antiAfkTimer');
}

function stopBeamTimer(runtime) {
  clearTimer(runtime, 'beamTimer');
}

async function stopRuntime(runtime, persist = true) {
  runtime.manualStop = true;
  runtime.beamEnabled = false;
  runtime.beamTarget = null;
  runtime.conversations.clear();
  stopBeamTimer(runtime);
  stopAntiAfk(runtime);
  clearTimer(runtime, 'connectionTimeout');
  clearTimer(runtime, 'reconnectTimer');

  stopAzaleaBot(runtime);
  const bot = runtime.bot;
  runtime.bot = null;
  runtime.joined = false;
  if (bot) {
    try {
      if (bot.socket && typeof bot.socket.destroy === 'function') bot.socket.destroy();
    } catch {}
    try {
      if (typeof bot.quit === 'function') bot.quit();
      else if (typeof bot.end === 'function') bot.end('Stopped');
    } catch {}
    try {
      if (typeof bot.removeAllListeners === 'function') bot.removeAllListeners();
    } catch {}
  }
  runtime.status = 'offline';
  runtime.lastError = null;
  if (persist) persistStatus(runtime.id, 'offline');
}

function profileFromTokenPayload(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const profile = Array.isArray(payload.pfd) ? payload.pfd.find((entry) => entry?.type === 'mc') : null;
    if (profile?.id && profile?.name) {
      return { id: String(profile.id).replace(/-/g, ''), name: String(profile.name) };
    }
  } catch {
    // Fall back to the Minecraft profile endpoint below.
  }
  return null;
}

async function resolveProfile(token) {
  const embedded = profileFromTokenPayload(token);
  if (embedded) return embedded;
  const result = await validateMinecraftToken(token);
  if (!result.ok) {
    throw new Error(result.message || result.reason || 'Minecraft token validation failed');
  }
  return {
    id: result.profile.uuid,
    name: result.profile.username,
  };
}

function pemToDer(pem) {
  return String(pem || '')
    .split('\n')
    .slice(1, -1)
    .reduce((buffer, line) => Buffer.concat([buffer, Buffer.from(line, 'base64')]), Buffer.alloc(0));
}

// Minecraft 1.19+ servers can require the account's secure-chat
// certificate. Fetching it is best effort, matching the reference manager:
// older/offline-mode servers still work when the endpoint is unavailable.
async function fetchProfileKeys(token) {
  const response = await fetch('https://api.minecraftservices.com/player/certificates', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`certificates HTTP ${response.status}`);
  const cert = await response.json();
  const publicDER = pemToDer(cert?.keyPair?.publicKey);
  const privateDER = pemToDer(cert?.keyPair?.privateKey);
  if (!publicDER.length || !privateDER.length || !cert?.expiresAt || !cert?.refreshedAfter) {
    throw new Error('certificate response was incomplete');
  }
  return {
    publicPEM: cert.keyPair.publicKey,
    privatePEM: cert.keyPair.privateKey,
    publicDER,
    privateDER,
    signature: cert.publicKeySignature ? Buffer.from(cert.publicKeySignature, 'base64') : undefined,
    signatureV2: cert.publicKeySignatureV2 ? Buffer.from(cert.publicKeySignatureV2, 'base64') : undefined,
    expiresOn: new Date(cert.expiresAt),
    refreshAfter: new Date(cert.refreshedAfter),
    public: crypto.createPublicKey({ key: publicDER, format: 'der', type: 'spki' }),
    private: crypto.createPrivateKey({ key: privateDER, format: 'der', type: 'pkcs8' }),
  };
}

function parseProxy(raw) {
  const value = asString(raw).trim();
  if (!value) return null;
  let url;
  try {
    url = new URL(value.includes('://') ? value : `socks5://${value}`);
  } catch {
    throw new Error('proxy must be a valid SOCKS address such as socks5://host:1080');
  }
  const protocol = url.protocol.toLowerCase();
  const type = protocol === 'socks4:' ? 4 : 5;
  if (!['socks:', 'socks4:', 'socks5:', 'socks5h:'].includes(protocol)) {
    throw new Error('proxy must use socks, socks4 or socks5');
  }
  const port = Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('proxy must include a host and port');
  }
  return {
    type,
    host: url.hostname,
    port,
    userId: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

async function loadMineflayer() {
  const mod = await import('mineflayer');
  return mod.default?.createBot ? mod.default : mod;
}

async function loadSocks() {
  const mod = await import('socks');
  return mod.SocksClient || mod.default?.SocksClient || mod.default;
}

function setStatus(runtime, status, error = null) {
  runtime.status = status;
  runtime.lastError = error ? clampText(error, 1000) : null;
  persistStatus(runtime.id, status, runtime.lastError);
}

function safeReason(reason) {
  if (reason == null) return 'connection ended';
  if (typeof reason === 'string') return reason.slice(0, 500);
  try {
    return JSON.stringify(reason).slice(0, 500);
  } catch {
    return String(reason).slice(0, 500);
  }
}

function profileForRecord(record, resolvedProfile) {
  return {
    ign: resolvedProfile?.name || record.username || 'cloubot',
    discord: record.discordUser || '',
    ytChannel: record.ytChannel || '',
    beamIp: record.beamIp || '',
  };
}

function configForRecord(record) {
  let resolved;
  try {
    resolved = buildBotConfig(record.ownerEmail, `${record.ownerEmail}|${record.host}`);
  } catch {
    resolved = {};
  }
  return {
    ...resolved,
    persona: {
      ...(resolved.persona || {}),
      ...profileForRecord(record, { name: record.username }),
    },
  };
}

function sendBotChat(runtime, message) {
  if (!runtime.bot || runtime.status !== 'online') return false;
  const text = clampText(message, 256);
  if (!text) return false;
  try {
    runtime.bot.chat(text);
    const pm = text.match(/^\/(?:msg|w|tell|whisper)\s+([A-Za-z0-9_]{3,16})\s+(.+)$/i);
    log(runtime, 'chat', pm ? `<you → ${pm[1]}> ${pm[2]}` : `<you> ${text}`);
    return true;
  } catch (error) {
    log(runtime, 'error', `failed to send chat: ${error?.message || error}`);
    return false;
  }
}

async function deliverConversation(runtime, conversation, result) {
  const record = findStoredBot(runtime.id);
  if (!record) return;
  for (const message of Array.isArray(result) ? result : []) {
    let text = message.text;
    const ai = conversation.config?.ai || {};
    if (message.scriptLine && ai.enabled && ai.key) {
      if (!consumeAiCredit(record.ownerEmail)) {
        log(runtime, 'system', 'AI credits exhausted — using scripted line');
      } else {
        text = await rephraseScriptedLine(conversation, message.scriptLine, message.text);
      }
    }
    sendBotChat(runtime, text);
  }
}

function startBeamTicker(runtime) {
  stopBeamTimer(runtime);
  runtime.beamTimer = setInterval(async () => {
    if (!runtime.beamEnabled || runtime.status !== 'online' || runtime.beamBusy) return;
    runtime.beamBusy = true;
    try {
      const timestamp = now();
      for (const [target, conversation] of runtime.conversations) {
        if (timestamp - conversation.lastTick < (conversation.config?.messaging?.turnCooldownMs || 1500)) continue;
        conversation.lastTick = timestamp;
        const result = step(conversation, null);
        if (result?.leave) {
          runtime.conversations.delete(target);
          log(runtime, 'system', `left ${target} (no reply)`);
          continue;
        }
        await deliverConversation(runtime, conversation, result);
      }
    } finally {
      runtime.beamBusy = false;
    }
  }, 1000);
}

function beginConversation(runtime, target) {
  const record = findStoredBot(runtime.id);
  if (!record || !target) return null;
  let conversation = runtime.conversations.get(target);
  if (conversation) return conversation;
  const cfg = configForRecord(record);
  conversation = newConversation(target, profileForRecord(record, runtime.profile), cfg);
  runtime.conversations.set(target, conversation);
  postMatchStart({
    webhookUrl: cfg.logging?.webhookUrl,
    target,
    botName: runtime.profile?.name || record.name,
    server: `${record.host}:${record.port}`,
    mode: record.beamType || 'ai',
  });
  log(runtime, 'system', `beam started for ${target}`);
  return conversation;
}

function handleIncomingChat(runtime, username, message) {
  const record = findStoredBot(runtime.id);
  const target = clampText(username, 32);
  const text = clampText(message, 1000);
  if (!record || !target || !text || target === runtime.profile?.name) return;
  log(runtime, 'chat', `<${target}> ${text}`);
  if (!runtime.beamEnabled) return;
  if (runtime.beamTarget && target.toLowerCase() !== runtime.beamTarget.toLowerCase()) return;
  const conversation = beginConversation(runtime, target);
  if (!conversation) return;
  void deliverConversation(runtime, conversation, step(conversation, text));
}

function parseAzaleaChatLine(line) {
  const text = clampText(line, 1000);
  let match = text.match(/^<([A-Za-z0-9_]{3,16})>\s*(.+)$/);
  if (match) return { username: match[1], message: match[2] };
  match = text.match(/^\(From\s+([A-Za-z0-9_]{3,16})\)\s*(.+)$/i);
  if (match) return { username: match[1], message: match[2] };
  match = text.match(/^([A-Za-z0-9_]{3,16})\s*(?:whispers?(?:\s+to\s+you)?|:)\s*(.+)$/i);
  if (match) return { username: match[1], message: match[2] };
  return null;
}

function handleIncomingAzaleaLine(runtime, line) {
  const parsed = parseAzaleaChatLine(line);
  if (parsed) handleIncomingChat(runtime, parsed.username, parsed.message);
}

function attachAzalea(runtime, record, profile) {
  runtime.profile = profile;
  runtime.azaleaSnap = null;
  const timeout = setTimeout(() => {
    if (!runtime.joined && runtime.status === 'connecting') {
      const message = 'Azalea connection timed out (server did not respond in 45s)';
      setStatus(runtime, 'error', message);
      log(runtime, 'error', message);
      try { runtime.bot?.quit(); } catch {}
    }
  }, Number(config.botConnectionTimeoutMs || 45_000));
  runtime.connectionTimeout = timeout;

  const clearConnectTimeout = () => {
    if (runtime.connectionTimeout === timeout) {
      clearTimeout(timeout);
      runtime.connectionTimeout = null;
    }
  };

  void startAzaleaBot(record, runtime, {
    onStarted: (_handle, binary) => {
      log(runtime, 'system', `starting Azalea sidecar (${binary})`);
    },
    onLog: (level, line) => log(runtime, level, line),
    onStatus: (status, handle) => {
      if (status !== 'online') return;
      clearConnectTimeout();
      runtime.bot = handle;
      runtime.joined = true;
      runtime.status = 'online';
      runtime.lastError = null;
      runtime.reconnectAttempts = 0;
      persistStatus(record.id, 'online', null, { username: profile.name, uuid: profile.id });
      log(runtime, 'system', `Azalea joined ${record.host}:${record.port}`);
    },
    onChat: (line) => handleIncomingAzaleaLine(runtime, line),
    onSnapshot: (snapshot) => {
      runtime.azaleaSnap = snapshot;
    },
    // Tab-list churn is extremely noisy on proxy networks and some servers
    // send malformed formatting codes as player names. The UI already shows
    // the useful spawn/join state, so do not flood the console with every
    // player add/remove packet.
    onPlayerAdded: () => {},
    onPlayerRemoved: () => {},
    onError: (message) => {
      if (!runtime.manualStop) {
        runtime.lastError = clampText(message, 1000);
        log(runtime, 'error', message);
        setStatus(runtime, 'error', message);
      }
    },
    onEnd: (reason) => {
      clearConnectTimeout();
      stopAntiAfk(runtime);
      runtime.joined = false;
      runtime.azaleaSnap = null;
      if (runtime.bot?.child && runtime.azaleaChild === null) runtime.bot = null;
      if (runtime.manualStop) {
        runtime.status = 'offline';
        runtime.lastError = null;
        persistStatus(record.id, 'offline');
        return;
      }
      const status = runtime.status === 'error' ? 'error' : 'offline';
      setStatus(runtime, status, status === 'error' ? runtime.lastError : null);
      log(runtime, status === 'error' ? 'error' : 'system', `Azalea disconnected: ${reason}`);
      scheduleReconnect(runtime);
    },
  }).then((started) => {
    if (!started && runtime.connectionTimeout === timeout) {
      clearTimeout(timeout);
      runtime.connectionTimeout = null;
    }
  }).catch((error) => {
    if (runtime.connectionTimeout === timeout) {
      clearTimeout(timeout);
      runtime.connectionTimeout = null;
    }
    setStatus(runtime, 'error', error?.message || String(error));
    log(runtime, 'error', error?.message || String(error));
  });
}

function scheduleReconnect(runtime) {
  const record = findStoredBot(runtime.id);
  if (!record || runtime.manualStop || !isEnabled(record)) return;
  if (runtime.reconnectAttempts >= MAX_RECONNECTS) {
    log(runtime, 'error', 'automatic reconnect limit reached; start the bot again from the dashboard');
    return;
  }
  clearTimer(runtime, 'reconnectTimer');
  runtime.reconnectAttempts += 1;
  const delay = Math.min(60_000, 2500 * runtime.reconnectAttempts);
  log(runtime, 'system', `reconnecting in ${Math.ceil(delay / 1000)}s`);
  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = null;
    void startBot(runtime.id);
  }, delay);
}

function attachMineflayer(runtime, record, profile, bot, timeout) {
  runtime.bot = bot;
  runtime.profile = profile;

  const clearConnectTimeout = () => {
    if (runtime.connectionTimeout === timeout) {
      clearTimeout(timeout);
      runtime.connectionTimeout = null;
    }
  };

  bot.once('login', () => {
    log(runtime, 'system', `logged in as ${profile.name}`);
  });

  bot.once('spawn', () => {
    clearConnectTimeout();
    runtime.joined = true;
    runtime.status = 'online';
    runtime.lastError = null;
    runtime.reconnectAttempts = 0;
    persistStatus(record.id, 'online', null, { username: profile.name, uuid: profile.id });
    log(runtime, 'system', `joined ${record.host}:${record.port}`);

    // Keep the same low-noise anti-AFK behavior exposed by the reference
    // manager. It is opt-in per bot and stops automatically on disconnect.
    if (record.antiAfk === true || record.antiAfk === 'true') {
      stopAntiAfk(runtime);
      const interval = Math.max(15, Number(record.antiAfkInterval) || 120) * 1000;
      const antiAfk = () => {
        if (!runtime.bot || runtime.status !== 'online') return;
        try {
          const client = runtime.bot._client;
          if (client?.write) {
            const action = Math.random() > 0.5 ? 0 : 4;
            client.write('entity_action', { entityId: 0, actionId: action, jumpBoost: 0 });
            setTimeout(() => {
              try {
                client?.write('entity_action', { entityId: 0, actionId: action === 0 ? 1 : 5, jumpBoost: 0 });
              } catch {}
            }, action === 0 ? 300 : 200);
          }
        } catch {}
      };
      runtime.antiAfkTimer = setInterval(antiAfk, interval);
    }
  });

  bot.on('messagestr', (message) => {
    const text = asString(message).trim();
    if (text) log(runtime, 'chat', text);
  });

  bot.on('chat', (username, message) => handleIncomingChat(runtime, username, message));
  bot.on('whisper', (username, message) => handleIncomingChat(runtime, username, message));

  bot.on('kicked', (reason) => {
    const text = `kicked: ${safeReason(reason)}`;
    runtime.joined = false;
    setStatus(runtime, 'error', text);
    log(runtime, 'error', text);
  });

  bot.on('error', (error) => {
    if (runtime.manualStop) return;
    const text = error?.message || String(error);
    runtime.lastError = text;
    log(runtime, 'error', text);
    // Mineflayer usually emits end after error; keep the status useful if it
    // does not, while allowing the end handler to schedule a reconnect.
    setStatus(runtime, 'error', text);
  });

  bot.on('end', (reason) => {
    clearConnectTimeout();
    stopAntiAfk(runtime);
    runtime.joined = false;
    if (runtime.bot === bot) runtime.bot = null;
    const why = safeReason(reason);
    if (runtime.manualStop) {
      runtime.status = 'offline';
      runtime.lastError = null;
      persistStatus(record.id, 'offline');
      log(runtime, 'system', 'bot stopped');
      return;
    }
    const status = runtime.status === 'error' ? 'error' : 'offline';
    const error = status === 'error' ? runtime.lastError : null;
    setStatus(runtime, status, error);
    log(runtime, status === 'error' ? 'error' : 'system', `disconnected: ${why}`);
    scheduleReconnect(runtime);
  });

  bot.on('playerJoined', (player) => {
    if (player?.username) log(runtime, 'system', `${player.username} joined`);
  });
  bot.on('playerLeft', (player) => {
    if (player?.username) log(runtime, 'system', `${player.username} left`);
  });
}

async function startMineflayer(runtime, record, profile, profileKeys = null) {
  let mineflayer;
  try {
    mineflayer = await loadMineflayer();
  } catch (error) {
    const message = `failed to load mineflayer: ${error?.message || error}`;
    setStatus(runtime, 'error', message);
    log(runtime, 'error', message);
    return;
  }

  let proxy;
  try {
    proxy = parseProxy(record.proxy);
  } catch (error) {
    const message = error?.message || String(error);
    setStatus(runtime, 'error', message);
    log(runtime, 'error', message);
    return;
  }

  let connect;
  if (proxy) {
    let SocksClient;
    try {
      SocksClient = await loadSocks();
    } catch (error) {
      const message = `proxy requested but socks failed to load: ${error?.message || error}`;
      setStatus(runtime, 'error', message);
      log(runtime, 'error', message);
      return;
    }
    log(runtime, 'system', `using SOCKS${proxy.type} proxy ${proxy.host}:${proxy.port}`);
    connect = (client) => {
      SocksClient.createConnection(
        {
          proxy: {
            host: proxy.host,
            port: proxy.port,
            type: proxy.type,
            userId: proxy.userId,
            password: proxy.password,
          },
          command: 'connect',
          destination: { host: record.host, port: record.port },
          timeout: 20_000,
        },
        (error, info) => {
          if (error || !info) {
            const message = `proxy connection failed: ${error?.message || 'unknown error'}`;
            log(runtime, 'error', message);
            client.emit('error', error || new Error(message));
            return;
          }
          client.setSocket(info.socket);
          client.emit('connect');
        },
      );
    };
  }

  const timeout = setTimeout(() => {
    if (!runtime.joined && runtime.status === 'connecting') {
      const message = 'connection timed out (server did not respond in 45s)';
      setStatus(runtime, 'error', message);
      log(runtime, 'error', message);
      try {
        runtime.bot?.quit();
      } catch {}
    }
  }, Number(config.botConnectionTimeoutMs || 45_000));
  runtime.connectionTimeout = timeout;

  try {
    const createOptions = {
      host: record.host,
      port: record.port,
      username: profile.name,
      version: record.version && record.version !== 'auto' ? record.version : false,
      hideErrors: true,
      brand: 'vanilla',
      viewDistance: 'far',
      chatLengthLimit: 256,
      checkTimeoutInterval: 60_000,
      keepAlive: true,
      ...(connect ? { connect } : {}),
      auth(client, options) {
        // Mineflayer's reference manager injects the already-issued bearer
        // token instead of launching an interactive Microsoft login flow.
        client.session = {
          accessToken: record.token,
          selectedProfile: { id: profile.id, name: profile.name },
          availableProfiles: [{ id: profile.id, name: profile.name }],
        };
        client.username = profile.name;
        options.accessToken = record.token;
        options.haveCredentials = true;
        if (profileKeys) client.profileKeys = profileKeys;
        if (connect) options.connect = connect;
        client.emit('session', client.session);
        options.connect(client);
      },
    };
    const bot = mineflayer.createBot(createOptions);
    attachMineflayer(runtime, record, profile, bot, timeout);
  } catch (error) {
    clearTimeout(timeout);
    runtime.connectionTimeout = null;
    const message = error?.message || String(error);
    setStatus(runtime, 'error', message);
    log(runtime, 'error', message);
  }
}

/** Start or restart one persisted bot. */
export async function startBot(id) {
  const record = findStoredBot(id);
  if (!record) throw new Error('bot not found');
  const runtime = runtimeFor(id);

  await stopRuntime(runtime, false);
  runtime.manualStop = false;
  runtime.status = 'connecting';
  runtime.lastError = null;
  runtime.reconnectAttempts = 0;
  persistStatus(id, 'connecting', null);
  log(runtime, 'system', `connecting to ${record.host}:${record.port}`);

  let profile;
  try {
    log(runtime, 'system', 'validating Minecraft token...');
    profile = await resolveProfile(record.token);
    runtime.profile = profile;
    patchStoredBot(id, { username: profile.name, uuid: profile.id });
    log(runtime, 'system', `authenticated as ${profile.name} (${profile.id})`);
  } catch (error) {
    const message = error?.message || String(error);
    setStatus(runtime, 'error', message);
    log(runtime, 'error', message);
    return;
  }

  const runnableRecord = { ...record, username: profile.name, uuid: profile.id };
  if ((record.engine || 'azalea') === 'azalea') {
    attachAzalea(runtime, runnableRecord, profile);
    return;
  }

  let profileKeys = null;
  try {
    profileKeys = await fetchProfileKeys(record.token);
    log(runtime, 'system', 'fetched Minecraft secure-chat certificates');
  } catch {
    log(runtime, 'system', 'secure-chat certificates unavailable; continuing without them');
  }

  await startMineflayer(runtime, runnableRecord, profile, profileKeys);
}

/** Stop a bot without deleting its configuration. */
export async function stopBot(id, { disable = false } = {}) {
  const record = findStoredBot(id);
  if (!record) throw new Error('bot not found');
  if (disable) patchStoredBot(id, { enabled: 'false' });
  await stopRuntime(runtimeFor(id), true);
}

/** Enable and start a bot. */
export async function enableBot(id) {
  const record = findStoredBot(id);
  if (!record) throw new Error('bot not found');
  patchStoredBot(id, { enabled: 'true' });
  void startBot(id);
}

/** Disable and stop a bot. */
export async function disableBot(id) {
  await stopBot(id, { disable: true });
}

/** Update configuration and restart if the bot was active. */
export async function updateBot(id, input = {}, { restart = true } = {}) {
  const before = findStoredBot(id);
  if (!before) throw new Error('bot not found');
  const wasActive = ['online', 'connecting'].includes(getRuntimeView(id).status);
  if (wasActive) await stopRuntime(runtimeFor(id), false);
  const updated = updateBotRecord(id, input);
  if (wasActive && restart && isEnabled(updated)) void startBot(id);
  return updated;
}

export async function deleteBot(id) {
  const record = findStoredBot(id);
  if (!record) return false;
  await stopRuntime(runtimeFor(id), false);
  runtimes.delete(id);
  saveBots(allBots().filter((bot) => bot.id !== id));
  return true;
}

export function sendChat(id, message) {
  return sendBotChat(runtimeFor(id), message);
}

function onlineRuntime(id) {
  const runtime = runtimeFor(id);
  if (!runtime.bot || runtime.status !== 'online') {
    return { runtime, error: 'bot is not online' };
  }
  return { runtime, error: null };
}

export async function selectHotbarSlot(id, slot) {
  const { runtime, error } = onlineRuntime(id);
  const n = Number(slot);
  if (error) return { ok: false, message: error };
  if (!Number.isInteger(n) || n < 0 || n > 8) return { ok: false, message: 'hotbar slot must be 0-8' };
  try {
    await runtime.bot.setQuickBarSlot(n);
    return { ok: true, message: `selected hotbar slot ${n}` };
  } catch (e) {
    return { ok: false, message: e?.message || String(e) };
  }
}

export async function useHeldItem(id) {
  const { runtime, error } = onlineRuntime(id);
  if (error) return { ok: false, message: error };
  try {
    runtime.bot.activateItem();
    return { ok: true, message: 'used held item' };
  } catch (e) {
    return { ok: false, message: e?.message || String(e) };
  }
}

export async function dropHeldItem(id) {
  const { runtime, error } = onlineRuntime(id);
  if (error) return { ok: false, message: error };
  try {
    if (typeof runtime.bot.tossStack === 'function' && runtime.bot.heldItem) {
      await runtime.bot.tossStack(runtime.bot.heldItem);
    } else if (runtime.bot._client?.write) {
      runtime.bot._client.write('drop_item', { dropStack: true, dropAll: false });
    } else {
      return { ok: false, message: 'inventory controls are unavailable' };
    }
    return { ok: true, message: 'dropped held item' };
  } catch (e) {
    return { ok: false, message: e?.message || String(e) };
  }
}

export async function moveBot(id, direction) {
  const { runtime, error } = onlineRuntime(id);
  if (error) return { ok: false, message: error };
  const allowed = new Set(['forward', 'back', 'left', 'right', 'jump', 'sneak']);
  const dir = asString(direction, 'forward').toLowerCase();
  if (!allowed.has(dir)) return { ok: false, message: 'unknown movement direction' };
  try {
    runtime.bot.setControlState(dir, true);
    setTimeout(() => {
      try { runtime.bot?.setControlState(dir, false); } catch {}
    }, dir === 'jump' ? 100 : 600);
    return { ok: true, message: `moving ${dir}` };
  } catch (e) {
    return { ok: false, message: e?.message || String(e) };
  }
}

export async function clickWindowSlot(id, slot) {
  const { runtime, error } = onlineRuntime(id);
  const n = Number(slot);
  if (error) return { ok: false, message: error };
  if (!Number.isInteger(n) || n < 0 || n > 53) return { ok: false, message: 'window slot must be 0-53' };
  try {
    if (!runtime.bot.currentWindow) return { ok: false, message: 'no inventory window is open' };
    await runtime.bot.clickWindow(n, 0, 0);
    return { ok: true, message: `clicked window slot ${n}` };
  } catch (e) {
    return { ok: false, message: e?.message || String(e) };
  }
}

export async function closeWindow(id) {
  const { runtime, error } = onlineRuntime(id);
  if (error) return { ok: false, message: error };
  try {
    if (runtime.bot.currentWindow) runtime.bot.closeWindow(runtime.bot.currentWindow);
    return { ok: true, message: 'closed inventory window' };
  } catch (e) {
    return { ok: false, message: e?.message || String(e) };
  }
}

export function getBeamState(id) {
  const runtime = runtimes.get(id);
  return {
    enabled: !!runtime?.beamEnabled,
    target: runtime?.beamTarget || null,
    targets: runtime ? [...runtime.conversations.keys()] : [],
  };
}

export async function startBeam(id, requestedTarget = '') {
  const { runtime, error } = onlineRuntime(id);
  if (error) return { ok: false, message: error };
  const record = findStoredBot(id);
  if (!record) return { ok: false, message: 'bot not found' };
  let target = clampText(requestedTarget, 32);
  if (!target) {
    const names = Object.keys(runtime.bot.players || {}).filter(
      (name) => name && name.toLowerCase() !== String(runtime.profile?.name || '').toLowerCase(),
    );
    target = names[0] || '';
  }
  if (!target) return { ok: false, message: 'no target player is visible; provide a target username' };
  runtime.beamEnabled = true;
  runtime.beamTarget = target;
  const conversation = beginConversation(runtime, target);
  startBeamTicker(runtime);
  await deliverConversation(runtime, conversation, step(conversation, true));
  return { ok: true, message: `beam started for ${target}`, target };
}

export async function stopBeam(id) {
  const runtime = runtimeFor(id);
  runtime.beamEnabled = false;
  runtime.beamTarget = null;
  runtime.conversations.clear();
  stopBeamTimer(runtime);
  return { ok: true, message: 'beam stopped' };
}

function itemView(item, slot = null, selected = false) {
  if (!item) return { slot, name: null, displayName: null, count: 0, selected };
  return {
    slot,
    name: item.name || null,
    displayName: item.displayName || item.name || null,
    count: Number(item.count || 0),
    selected,
  };
}

export function getViewSnapshot(id) {
  const runtime = runtimes.get(id);
  const bot = runtime?.bot;
  if (!bot || runtime?.status !== 'online') return { available: false };
  if (runtime.azaleaSnap) {
    const players = Object.values(bot.players || {}).map((player) => ({
      username: player.username,
      position: player.entity?.position
        ? { x: player.entity.position.x, y: player.entity.position.y, z: player.entity.position.z }
        : null,
    }));
    return {
      ...runtime.azaleaSnap,
      available: true,
      username: runtime.azaleaSnap.username || bot.username || runtime.profile?.name || null,
      players,
      window: runtime.azaleaSnap.window || null,
    };
  }
  const position = bot.entity?.position;
  const hotbar = Array.from({ length: 9 }, (_, slot) => itemView(bot.inventory?.slots?.[36 + slot], slot, bot.quickBarSlot === slot));
  const players = Object.values(bot.players || {}).map((player) => ({
    username: player.username,
    position: player.entity?.position
      ? { x: player.entity.position.x, y: player.entity.position.y, z: player.entity.position.z }
      : null,
  }));
  const window = bot.currentWindow
    ? {
        title: typeof bot.currentWindow.title === 'string' ? bot.currentWindow.title : 'Inventory',
        slots: (bot.currentWindow.slots || []).map((item, slot) => itemView(item, slot)),
      }
    : null;
  return {
    available: true,
    username: bot.username || runtime.profile?.name || null,
    position: position ? { x: position.x, y: position.y, z: position.z } : { x: 0, y: 0, z: 0 },
    yaw: Number(bot.entity?.yaw || 0),
    pitch: Number(bot.entity?.pitch || 0),
    health: Number(bot.health ?? 20),
    food: Number(bot.food ?? 20),
    dimension: bot.game?.dimension || null,
    heldItem: itemView(bot.heldItem).name,
    hotbar,
    players,
    window,
  };
}

/** Resume enabled bots once when the Node process starts. */
export async function resumeEnabledBots() {
  if (resumeStarted) return;
  resumeStarted = true;
  const enabled = allBots().filter(isEnabled);
  enabled.forEach((record, index) => {
    setTimeout(() => {
      void startBot(record.id);
    }, 500 + index * 1500);
  });
}

export function stopAllBots() {
  for (const id of runtimes.keys()) void stopBot(id);
}

export function resetBotManagerForTests() {
  for (const runtime of runtimes.values()) {
    void stopRuntime(runtime, false);
  }
  runtimes.clear();
  resumeStarted = false;
}
