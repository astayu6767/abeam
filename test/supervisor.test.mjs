import assert from 'node:assert';
import { slotArgs } from '../bots/supervisor.js';

const args = slotArgs('you@example.com', 'mc.example.com', {
  mcAccessToken: 'tok',
  mcUuid: '0000',
  mcUsername: 'abot',
});
assert.ok(args.includes('--slot-id'), 'should pass --slot-id');
const i = args.indexOf('--slot-id');
assert.strictEqual(args[i + 1], 'you@example.com|mc.example.com', 'slot-id should be email|server');
assert.ok(args.includes('--server') && args.includes('mc.example.com'), 'server flag present');
assert.ok(args.includes('--mc-access-token') && args.includes('tok'), 'mc token passed for online mode');
console.log('PASS supervisor slotArgs');
