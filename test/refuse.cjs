// Refusal + silent-leave integration test.
const { WebSocket } = require('ws');
const BASE = 'http://localhost:8080';

async function main() {
  const tokRes = await fetch(`${BASE}/api/tokens`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'refuse@abeam.dev' }) });
  const { ssid } = await tokRes.json();

  const botWs = new WebSocket(`ws://localhost:8080/ws/bot?ssid=${ssid}`);
  botWs.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'msg') console.log(`  BOT→[${m.target}]: ${m.text}`);
    else console.log('  BOT event:', JSON.stringify(m));
  });
  await new Promise((r) => botWs.on('open', r));
  console.log('bot connected');

  // Engage Steve, then have him refuse.
  botWs.send(JSON.stringify({ type: 'flush', target: 'Steve' }));
  setTimeout(() => botWs.send(JSON.stringify({ type: 'chat', target: 'Steve', text: 'nah im good' })), 1500);

  // Engage Bob, then go silent to test the 40s leave.
  botWs.send(JSON.stringify({ type: 'flush', target: 'Bob' }));

  setTimeout(() => { botWs.close(); process.exit(0); }, 25000);
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
