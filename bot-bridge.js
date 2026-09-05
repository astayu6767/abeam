import { WebSocketServer } from 'ws';
import { URL } from 'node:url';
import { validateToken } from './auth/ssid.js';
import { getSessionUser } from './auth/web-session.js';
import { newConversation, step, rephraseScriptedLine } from './conversation/index.js';
import { buildBotConfig } from './billing/subscribers.js';
import { consumeAiCredit } from './billing/credits.js';
import { postMatchStart } from './webhook/index.js';
import { config } from './config.js';
import { isAdminUser } from './admin-check.js';

/**
 * Bridge between the Rust bots (one WS per managed slot) and the browser
 * consoles.
 *
 * Each bot connects with its SSID (=> subscriber email) and identifies its
 * managed slot (slotId = `email|server`) via the `login` frame. Console
 * browsers subscribe to a specific slot with `?ssid=<ssid>&slot=<slotId>` and
 * only ever see that subscriber's own bot traffic.
 */
export function createBotBridge(server, { onLeave }) {
  const wss = new WebSocketServer({ noServer: true });
  const bots = new Map(); // slotId -> { ws, email, profile, conversations, ticker }
  const pendingBots = new Map(); // ws -> { email }  (waiting for a login slotId)
  const consoles = new Map(); // email -> Set<ws>
  const consoleSlots = new Map(); // ws -> slotId
  const adminConsoles = new Map(); // ws -> slotId (administrator cross-account viewers)

  function tokenEmail(req) {
    const authHeader = req.headers['authorization'] || '';
    const bearer = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';
    const ssid = new URL(req.url, 'http://x').searchParams.get('ssid')
      || req.headers['x-ssid']
      || bearer
      || '';
    const auth = validateToken(ssid);
    return { email: auth?.email || null, ssid };
  }

  function broadcastToConsoles(msg, slotId) {
    if (!slotId) return;
    const data = JSON.stringify({ ...msg, slotId });
    for (const [ws, sid] of consoleSlots) {
      if (sid !== slotId) continue;
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
    for (const [ws, sid] of adminConsoles) {
      if (sid !== slotId) continue;
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  function removeBot(slotId, profile) {
    const entry = bots.get(slotId);
    if (entry) {
      if (entry.ticker) clearInterval(entry.ticker);
      bots.delete(slotId);
      if (onLeave) onLeave(profile);
    }
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    if (pathname !== '/ws/bot' && pathname !== '/ws/console') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (pathname === '/ws/console') {
        wss.emit('console', ws, req);
      } else {
        wss.emit('connection', ws, req, url);
      }
    });
  });

  wss.on('console', (ws, req) => {
    const { email, ssid } = tokenEmail(req);
    const url = new URL(req.url, 'http://x');
    const slotId = url.searchParams.get('slot') || '';
    // Administrator: verified web session that is an operator. May watch any slot.
    const sessionUser = getSessionUser(req, config.sessionSecret);
    const isAdmin = isAdminUser(sessionUser);
    const own = !!email && slotId && slotId.split('|')[0] === email;
    if (!isAdmin && !own) {
      ws.close(4003, 'unauthorized: slot does not belong to session');
      return;
    }
    consoleSlots.set(ws, slotId);
    if (isAdmin) {
      adminConsoles.set(ws, slotId);
    } else {
      if (!consoles.has(email)) consoles.set(email, new Set());
      consoles.get(email).add(ws);
    }
    ws.on('close', () => {
      if (isAdmin) { adminConsoles.delete(ws); }
      else {
        consoles.get(email)?.delete(ws);
        consoleSlots.delete(ws);
      }
    });
    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'hello', service: 'abeam console', slotId, admin: !!isAdmin }));

    // Forward operator console commands to the owning bot over its WS.
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m || typeof m.type !== 'string') return;
      const bot = bots.get(slotId);
      if (!bot || !slotId) return;
      if (m.type === 'inventory') {
        if (bot.ws.readyState === bot.ws.OPEN) {
          bot.ws.send(JSON.stringify({ type: 'inventory' }));
        }
        return;
      }
      if (m.type === 'click' || m.type === 'anti_afk') {
        if (bot.ws.readyState === bot.ws.OPEN) {
          bot.ws.send(JSON.stringify({
            type: m.type,
            slot: typeof m.slot === 'number' ? m.slot : undefined,
            button: m.button,
            enabled: typeof m.enabled === 'boolean' ? m.enabled : undefined,
          }));
        }
      }
    });
  });

  wss.on('connection', (ws, req, url) => {
    const { email, ssid } = tokenEmail(req);
    if (!email) {
      ws.close(4001, 'unauthorized: bad ssid');
      return;
    }

    pendingBots.set(ws, { email, ssid });

    const profile = {
      email,
      username: 'bot',
      slotId: null,
      mode: 'sword',
      geminiKey: '',
      geminiModel: '',
      config: {},
    };

    let slotId = null;
    let conversations = new Map();
    let ticker = null;

    const botSend = (payload) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    const deliver = async (conv, res) => {
      for (const m of Array.isArray(res) ? res : []) {
        let text = m.text;
        if (m.scriptLine && profile.config.ai?.enabled && profile.config.ai?.key) {
          // Only spend a credit when the account can afford it.
          if (!consumeAiCredit(email)) {
            broadcastToConsoles({ type: 'system', message: 'AI credits exhausted — using scripted line' }, slotId);
          } else {
            text = await rephraseScriptedLine(conv, m.scriptLine, m.text);
          }
        }
        botSend({ type: 'msg', target: conv.target, text });
        broadcastToConsoles({ type: 'chat', target: conv.target, from: 'bot', text }, slotId);
      }
    };

    const logMatch = (target) => {
      if (!target) return;
      postMatchStart({
        webhookUrl: profile.config?.logging?.webhookUrl,
        target,
        botName: profile.username || profile.email,
        server: (slotId || '').split('|')[1] || '',
        mode: profile.mode,
      });
    };

    const tick = () => {
      const now = Date.now();
      for (const [target, conv] of conversations) {
        if (now - conv.lastTick < (conv.config?.messaging?.turnCooldownMs || 1500)) continue;
        conv.lastTick = now;
        const res = step(conv, null);
        if (res && res.leave) {
          conversations.delete(target);
          botSend({ type: 'leave', target });
          broadcastToConsoles({ type: 'system', message: `left ${target} (no reply)` }, slotId);
          continue;
        }
        deliver(conv, res);
      }
    };

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case 'login': {
          profile.username = msg.username || profile.username;
          profile.mode = msg.mode || profile.mode;
          profile.geminiKey = msg.geminiKey || '';
          profile.geminiModel = msg.geminiModel || '';
          const sid = msg.slotId || url.searchParams.get('slot') || '';
          if (sid) {
            // Bind this bot to its slot; reject a duplicate on the same slot.
            const existing = bots.get(sid);
            if (existing && existing.ws !== ws && existing.ws.readyState === existing.ws.OPEN) {
              ws.close(4002, `another bot already on slot ${sid}`);
              return;
            }
            slotId = sid;
            profile.slotId = sid;
            profile.config = buildBotConfig(email, sid);
            pendingBots.delete(ws);
            if (bots.has(sid) && bots.get(sid).ws === ws) {
              // re-login on the same socket: keep entry
            }
            bots.set(sid, { ws, email, profile, conversations, ticker });
            broadcastToConsoles(
              { type: 'system', message: `bot online (${profile.username || profile.email})` },
              sid,
            );
          }
          break;
        }

        case 'flush':
        case 'target': {
          if (!slotId) {
            // No slot bound yet; log the target as a system event only if we
            // can still route — otherwise ignore and stay safe.
            return;
          }
          const t = msg.target;
          if (t && !conversations.has(t)) {
            const conv = newConversation(t, profile, profile.config);
            conversations.set(t, conv);
            broadcastToConsoles({ type: 'system', message: `match started on ${t}` }, slotId);
            logMatch(t);
            await deliver(conv, step(conv, true));
          }
          break;
        }

        case 'chat': {
          if (!slotId) return;
          const t = msg.target;
          let conv = conversations.get(t);
          if (!conv) {
            conv = newConversation(t, profile, profile.config);
            conversations.set(t, conv);
            logMatch(t);
          }
          broadcastToConsoles({ type: 'chat', target: t, from: 'target', text: msg.text }, slotId);
          const res = step(conv, msg.text);
          if (res && res.leave) {
            conversations.delete(t);
            botSend({ type: 'leave', target: t });
            broadcastToConsoles({ type: 'system', message: `left ${t}` }, slotId);
            return;
          }
          await deliver(conv, res);
          break;
        }

        case 'disconnected':
          broadcastToConsoles({ type: 'system', message: 'bot disconnected' }, slotId);
          break;

        case 'inventory': {
          if (!slotId) return;
          broadcastToConsoles(
            { type: 'inventory', slots: msg.slots || [], guiOpen: !!msg.gui_open },
            slotId,
          );
          break;
        }

        case 'gui': {
          if (!slotId) return;
          broadcastToConsoles({ type: 'gui', open: !!msg.gui_open }, slotId);
          break;
        }
      }
    });

    ws.on('error', () => {});
    ws.on('close', () => {
      pendingBots.delete(ws);
      if (slotId) {
        removeBot(slotId, profile);
        broadcastToConsoles({ type: 'system', message: 'bot offline' }, slotId);
      }
    });

    ticker = setInterval(tick, 1500);
  });

  return { broadcast: (msg) => broadcastToConsoles(msg, msg?.slotId), bots, consoleSlots };
}
