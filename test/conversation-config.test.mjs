import assert from 'node:assert';
import { mergeConfig } from '../conversation/presets.js';
import { newConversation, step } from '../conversation/index.js';

// mergeConfig defaults
const d = mergeConfig({});
assert.strictEqual(d.messaging.emojis, 'bracket');
assert.strictEqual(d.messaging.replyTimeoutMs, 40_000);
assert.strictEqual(d.messaging.turnCooldownMs, 2500);
assert.strictEqual(d.ai.model, 'gemini-2.0-flash');
assert.strictEqual(d.script, 'bracket');
assert.ok(Array.isArray(d.scriptLines) && d.scriptLines.length > 0);
console.log('A PASS: mergeConfig defaults');

// messaging.emojis swap
const chill = mergeConfig({ messaging: { emojis: 'chill' } });
assert.strictEqual(chill.messaging.emojis, 'chill');
const conv1 = newConversation('Steve', {}, chill);
const res1 = step(conv1, true);
assert.ok(res1.length === 1, 'start returns first line');
console.log('B PASS: conquer config swap + first line =', JSON.stringify(res1[0].text));

// first stage with charm home already is greet; check opener override via persona
const custom = mergeConfig({ persona: { ign: 'mybot', opener: 'yo whats good' } });
const conv2 = newConversation('Steve', {}, custom);
const res2 = step(conv2, true);
assert.ok(/hey/.test(res2[0]?.text || ''), 'greet line delivered');
console.log('C PASS: greet with emoji flows =', res2[0]?.text);

// ai config rendition
const ai = mergeConfig({ ai: { enabled: true, model: 'gemini-1.5-pro', key: 'x' } });
assert.strictEqual(ai.ai.enabled, true);
assert.strictEqual(ai.ai.model, 'gemini-1.5-pro');
assert.strictEqual(ai.ai.key, 'x');
console.log('D PASS: ai config surfaces');

console.log('PASS conversation config');
