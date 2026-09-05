// Integration test: drives a fake Rust bot + console through the backend bridge.
// Run with: node test/e2e.js   (server must be running on :8080)
const { WebSocket } = require('ws');

const BASE = 'http://localhost:8080';

async function main() {
  // 1. Create a token
  const tokRes = await fetch(`${BASE}/api/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'drill@abeam.dev' }),
  });
  const { ssid } = await tokRes.json();
  console.log('token:', ssid);

  // 2. Connect fake bot the way abeam.exe does: Authorization: Bearer header.
  const botWs = new WebSocket(`ws://localhost:8080/ws/bot`, {
    headers: { Authorization: `Bearer ${ssid}` },
  });
  const queue = [];
  const waiters = new Map();
  let seq = 0;

  botWs.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'msg') {
      console.log(`  BOT→target [${m.target}]: ${m.text}`);
      // auto-respond as a chatty target to keep flow going
      const t = m.target;
      queue.push({ target: t, text: `yo ${++seq}` });
    } else {
      console.log('  BOT event:', JSON.stringify(m));
    }
  });

  await new Promise((r) => botWs.on('open', r));
  console.log('bot connected');

  // 3. Engage a target the way the bot does (send `login` then `target`).
  botWs.send(JSON.stringify({ type: 'login', username: 'autobeam', mode: 'sword' }));
  botWs.send(JSON.stringify({ type: 'target', target: 'Steve' }));

  // pump target replies + give backend time to tick
  const pump = setInterval(() => {
    const brown = queue.shift();
    if (brown) botWs.send(JSON.stringify({ type: 'chat', target: brown.target, text: brown.text }));
  }, 1200);

  // also connect a console to verify bridging
  const conWs = new WebSocket('ws://localhost:8080/ws/console');
  conWs.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'chat') console.log(`  [console] ${m.from} → ${m.target}: ${m.text}`);
  });
  await new Promise((r) => conWs.on('open', r));

  // Let it run ~12s then stop
  setTimeout(() => {
    clearInterval(pump);
    botWs.close();
    conWs.close();
    process.exit(0);
  }, 12000);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
