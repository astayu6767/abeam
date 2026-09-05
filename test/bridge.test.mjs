import assert from 'node:assert';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createBotBridge } from '../bot-bridge.js';
import { createToken } from '../auth/ssid.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((_req, res) => res.end('ok'));
createBotBridge(server, { onLeave: () => {} });
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const email = 'bridge' + Date.now() + '@example.com';
const ssid = createToken(email);
const otherEmail = 'other' + Date.now() + '@example.com';
const otherSsid = createToken(otherEmail);

function botWs(slotId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/bot`, {
      headers: { Authorization: `Bearer ${ssid}` },
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'login', username: 'abot', slotId }));
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

function consoleWs(slotTuple) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/console?ssid=${ssid}&slot=${encodeURIComponent(slotTuple)}`,
    );
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Test A: two different slots for the same subscriber stay open simultaneously.
const a = await botWs(`${email}|s1`);
const b = await botWs(`${email}|s2`);
await delay(300);
assert.strictEqual(a.readyState, a.OPEN, 'bot A (slot s1) stays open');
assert.strictEqual(b.readyState, b.OPEN, 'bot B (slot s2) stays open');
console.log('A PASS: two per-slot bots coexist');

// Test B: a console can subscribe to its own slot and receives slot-scoped events.
const gotSys = new Promise((resolve) => {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/console?ssid=${ssid}&slot=${encodeURIComponent(`${email}|s1`)}`,
  );
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'chat' && m.target === 'Steve') resolve(m);
  });
});
await delay(200);
a.send(JSON.stringify({ type: 'chat', target: 'Steve', text: 'yo' }));
const got = await Promise.race([gotSys, delay(1500).then(() => null)]);
assert.ok(got, 'console for slot s1 received the chat event for s1');
console.log('B PASS: console receives slot-scoped chat, slotId present =', got?.slotId);

// Test C: a subscriber cannot subscribe to another subscriber's slot (rejected).
const evil = new Promise((resolve) => {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/console?ssid=${otherSsid}&slot=${encodeURIComponent(`${email}|s1`)}`,
  );
  ws.on('close', (code) => resolve(code));
  ws.on('error', () => {});
});
const evilCode = await Promise.race([evil, delay(1500).then(() => null)]);
assert.strictEqual(evilCode, 4003, 'cross-subscriber console subscription is rejected');
console.log('C PASS: cross-subscriber console access blocked');

a.close();
b.close();
server.close();
console.log('PASS bridge per-slot routing + scoped consoles');
process.exit(0);
