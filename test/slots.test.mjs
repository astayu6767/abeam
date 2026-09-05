import assert from 'node:assert';
import { store } from '../store/index.js';
import {
  setSlotConfig,
  getSlotConfig,
  buildBotConfig,
  setTargetServers,
} from '../billing/subscribers.js';

const email = 'configtest' + Date.now() + '@example.com';
const subs = store.subscribers.all();
subs[email] = {
  email,
  planId: 'hunter',
  botSlots: 2,
  ssids: [],
  targetServers: ['srvA', 'srvB'],
  mcTokens: [],
  configs: [],
  since: Date.now(),
  status: 'active',
  demo: false,
};
store.subscribers.save(subs);

// setSlotConfig round-trip
const saved = setSlotConfig(email, 0, { persona: { ign: 'zerobot' }, ai: { model: 'gemini-1.5-pro' } });
assert.strictEqual(saved.persona.ign, 'zerobot', 'persona saved');
const sub = store.subscribers.all()[email];
assert.strictEqual(getSlotConfig(sub, 0).ai.model, 'gemini-1.5-pro', 'ai saved');

// buildBotConfig resolves merged config for a slot by server
const cfg = buildBotConfig(email, `${email}|srvB`);
assert.strictEqual(cfg.persona.ign, 'cloubot', 'slot B uses defaults (no override)');
const cfgA = buildBotConfig(email, `${email}|srvA`);
assert.strictEqual(cfgA.persona.ign, 'zerobot', 'slot A picks its persona');
assert.strictEqual(cfgA.ai.model, 'gemini-1.5-pro', 'slot A picks its ai model');

// invalid index throws
assert.throws(() => setSlotConfig(email, 5, {}), /invalid slot index/);

// cleanup
const all = store.subscribers.all();
delete all[email];
store.subscribers.save(all);

console.log('PASS slots config helpers');
