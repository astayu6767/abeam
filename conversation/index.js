import { generateReply } from '../ai/index.js';
import {
  EMOJI_SET,
  FAILURE_LINES,
  REFUSE_RE,
  mergeConfig,
} from './presets.js';

// Conversation state machine (per target conversation).
// The Rust bot is a dumb chat I/O driver; ALL decision making lives here.
// Every message/timing/emoji decision reads from `conv.config` so each bot
// slot can be edited independently.

function stageIndex(conv) {
  return conv.script.findIndex((s) => s.id === conv.stage);
}

export function newConversation(target, persona, config = mergeConfig()) {
  const resolved = config?.scriptLines && config?.messaging ? config : mergeConfig(config);
  return {
    id: `${target}-${Date.now().toString(36)}`,
    target,
    persona,
    config: resolved,
    script: resolved.scriptLines,
    stage: '__start__',
    log: [],
    awaitingReply: false,
    stepStartedAt: Date.now(),
    lastTick: Date.now(),
    refused: false,
  };
}

function pushLog(conv, from, text) {
  conv.log.push({ from, text, at: Date.now() });
  if (conv.log.length > 60) conv.log.shift();
}

function emit(conv, from, text) {
  pushLog(conv, from, text);
  return { from, text, at: Date.now() };
}

function nextStep(conv) {
  return conv.script[stageIndex(conv) + 1] || null;
}

function emojiFor(conv, id) {
  const set = EMOJI_SET[conv.config.messaging?.emojis] || EMOJI_SET.bracket;
  return set[id] || '';
}

/**
 * Drive the conversation.
 *
 * @param conv       the conversation object
 * @param incoming   - string: target sent this message
 *                   - true:    start the conversation (fire first step)
 *                   - null:    time tick (only checks leave timeouts)
 *
 * @returns []                      nothing to do
 *          [{from,text}...]        messages to send to the target
 *          { leave: true }         target went silent -> disconnect
 *          { say: {text, stage} }  rephrase-hint (advanced to next step)
 */
export function step(conv, incoming) {
  const now = Date.now();

  if (incoming === true) {
    // Explicit start (a new sword target was flushed).
    return advance(conv);
  }

  if (typeof incoming === 'string') {
    conv.awaitingReply = false;
    conv.lastSeen = now;
    pushLog(conv, 'target', incoming);
    return onTargetMessage(conv, incoming);
  }

  // Time tick: leave once the reply timeout elapses.
  const timeoutMs = conv.config.messaging?.replyTimeoutMs ?? 40_000;
  const cur = conv.script[stageIndex(conv)] || null;
  if (cur && cur.wait === 'reply' && conv.awaitingReply) {
    if (now - conv.stepStartedAt >= timeoutMs) {
      return { leave: true };
    }
    return [];
  }
  if (cur && cur.wait === 'time' && cur.thenLeave) {
    if (now - conv.stepStartedAt >= cur.timeoutMs) {
      return { leave: true };
    }
  }
  return [];
}

function advance(conv) {
  const next = nextStep(conv);
  if (!next) return [];
  conv.stage = next.id;
  conv.stepStartedAt = Date.now();
  conv.awaitingReply = next.wait === 'reply';
  if (next.say) {
    const emoji = emojiFor(conv, next.id) || next.emoji || '';
    let text = next.say;
    if (text.includes('{discord}')) {
      text = text.replace('{discord}', conv.persona?.discord || conv.config?.persona?.discord || '');
    }
    const say = emoji ? `${emoji} ${text}` : text;
    const m = emit(conv, 'bot', say);
    m.scriptStage = next.id;
    m.scriptLine = text;
    m.wait = next.wait;
    return [m];
  }
  return [];
}

function onTargetMessage(conv, incoming) {
  // If the target clearly refuses, pivot to a graceful goodbye and leave.
  if (REFUSE_RE.test(incoming)) {
    conv.refused = true;
    conv.stage = 'done';
    conv.stepStartedAt = Date.now();
    conv.awaitingReply = false;
    const m = emit(conv, 'bot', FAILURE_LINES[0]);
    m.goodbye = true;
    return [m];
  }
  // Otherwise advance to the next step of the scripted flow. The "say" is
  // a hint the AI can rephrase; the bridge calls rephraseScriptedLine() if
  // a Gemini key is configured.
  return advance(conv);
}

/**
 * Rephrase a scripted line with the AI (keeps the narrative but in a more
 * natural voice). Falls back to the original line on any error.
 */
export async function rephraseScriptedLine(conv, scriptedLine, fallbackText) {
  try {
    const ai = conv.config?.ai || {};
    const persona = { ...(conv.persona || {}), geminiKey: ai.key, geminiModel: ai.model };
    const reply = await generateReply(
      { profile: persona, log: conv.log },
      `[next line to say in-character] ${scriptedLine}`,
    );
    return (reply || fallbackText).trim();
  } catch {
    return fallbackText;
  }
}
