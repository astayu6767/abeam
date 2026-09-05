import assert from 'node:assert/strict';
import {
  createBot,
  listBots,
  countBots,
  updateBotRecord,
  deleteBot,
  getViewSnapshot,
} from '../bots/manager.js';

const email = `manager-${Date.now()}@example.com`;
const created = createBot(email, {
  name: 'test bot',
  token: 'minecraft-token-placeholder',
  host: 'mc.example.test:25566',
});

assert.equal(created.host, 'mc.example.test');
assert.equal(created.port, 25566);
assert.equal(countBots(email), 1);

const listed = listBots(email)[0];
assert.equal(listed.hasToken, true);
assert.equal(listed.engine, 'azalea');
assert.equal('token' in listed, false, 'raw Minecraft token must not be returned');
assert.equal(listed.status, 'offline');
assert.equal(getViewSnapshot(created.id).available, false);

const updated = updateBotRecord(created.id, { name: 'renamed bot', port: 25567 });
assert.equal(updated.name, 'renamed bot');
assert.equal(updated.port, 25567);

assert.equal(await deleteBot(created.id), true);
assert.equal(countBots(email), 0);
console.log('PASS bot manager persistence + token masking');
