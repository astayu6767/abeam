// Per-slot bot configuration: shape, defaults, presets, and merge helper.
// Everything that makes a conversation runnable & personalized lives here so
// that conversation/index.js only ever reads from a resolved `config`.
import { config } from '../config.js';

export const EMOJI_SET = {
  bracket: { greet: '👋', hook: '🔥', tournament: '🏆', pitch: '⚔️', discord: '💬', final: '✅', cheer: '🙌' },
  chill: { greet: '🫱', hook: '😎', tournament: '🏆', pitch: '🤝', discord: '💬', final: '👌', cheer: '🤙' },
};

export const SCRIPT_PRESETS = {
  bracket: [
    { id: 'greet', emoji: '👋', say: 'hey', wait: 'reply' },
    {
      id: 'hook',
      emoji: '🔥',
      say: 'yo u on this server often? i saw ur name on the w/l board, ur actually clean',
      wait: 'reply',
    },
    {
      id: 'tournament',
      emoji: '🏆',
      say: 'anyway i run this tiny x1 bracket on the side, $50 entry, pays out same night',
      wait: 'reply',
    },
    {
      id: 'pitch',
      emoji: '⚔️',
      say: 'need 1 more to fill before it closes, u in? i can spot u the entry if ur short',
      wait: 'reply',
    },
    {
      id: 'discord',
      emoji: '💬',
      say: 'sick, add me on discord so i can send u the invite and the rules, my @ is {discord}. real quick 20 sec',
      wait: 'reply',
    },
    {
      id: 'final',
      emoji: '✅',
      say: 'yo did u get the invite? lmk when ur in so we can start',
      wait: 'reply',
    },
    { id: 'done', wait: 'time', timeoutMs: 20_000, thenLeave: true },
  ],
};

export const FAILURE_LINES = [
  'aight, no worries. lmk if u change ur mind, spots fill fast',
  'cool cool, no pressure. hmu if u wanna run a friendly later',
];

export const REFUSE_RE = /no|nah|nope|not interested|leave me|stop|fuck off|block|reported|scam/i;

export const DEFAULT_CONFIG = {
  persona: {
    ign: 'cloubot',
    opener: '',
    bio: '',
    discord: '',
  },
  script: 'bracket',
  scriptLines: null, // explicit override (array) beats the preset name
  ai: {
    enabled: false,
    key: '',
    model: 'gemini-2.0-flash',
  },
  logging: {
    enabled: false,
    webhookUrl: '',
  },
  targeting: {
    mode: 'sword',
    maxTargets: 10,
    cooldownMs: 60_000,
    servers: [],
  },
  messaging: {
    emojis: 'bracket',
    replyTimeoutMs: 40_000,
    turnCooldownMs: 2500,
  },
};

/**
 * Deep-merge a partial per-slot config onto the defaults and resolve the
 * active script lines. Unknown keys are dropped.
 */
export function mergeConfig(input = {}) {
  const persona = { ...DEFAULT_CONFIG.persona, ...(input.persona || {}) };
  const ai = { ...DEFAULT_CONFIG.ai, ...(input.ai || {}) };
  // The operator owns the Beam AI key centrally; members only enable + spend
  // credits. A per-slot key (legacy) only survives when no central key exists.
  if (config.aiKey) ai.key = config.aiKey;
  const logging = { ...DEFAULT_CONFIG.logging, ...(input.logging || {}) };
  const targeting = { ...DEFAULT_CONFIG.targeting, ...(input.targeting || {}) };
  const messaging = { ...DEFAULT_CONFIG.messaging, ...(input.messaging || {}) };
  const script =
    Array.isArray(input.scriptLines) && input.scriptLines.length
      ? input.scriptLines
      : SCRIPT_PRESETS[input.script] || SCRIPT_PRESETS[DEFAULT_CONFIG.script];
  return {
    persona,
    script: input.script || DEFAULT_CONFIG.script,
    scriptLines: script,
    ai,
    logging,
    targeting,
    messaging,
  };
}
