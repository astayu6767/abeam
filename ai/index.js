import crypto from 'node:crypto';
import { config } from '../config.js';

const GEMINI_URL_PREFIX = 'https://generativelanguage.googleapis.com/v1beta/models';
const aiProviderLog = [];

function recordAiProvider(provider, ms) {
  aiProviderLog.push({ provider, ms: Math.max(0, Number(ms) || 0) });
  if (aiProviderLog.length > 50) aiProviderLog.splice(0, aiProviderLog.length - 50);
}

export function getAiProviderStats() {
  const last = aiProviderLog[aiProviderLog.length - 1] || null;
  const stats = { gemini: 0, fallback: 0, pollinations: 0, openrouter: 0, failed: 0 };
  for (const entry of aiProviderLog) {
    if (entry.provider in stats) stats[entry.provider] += 1;
  }
  return {
    lastProvider: last?.provider || null,
    ...stats,
    lastLatencyMs: last?.ms || 0,
    configured: !!(process.env.GEMINI_API_KEY || config.aiKey),
  };
}

const DIRECTIVES = {
  tournament: /bracket|tournament|1v1|one v one|comp|scrim|wager|bet|money back|win back|private match/i,
  venue: /discord|copy me|add me|join.*(server|discord)|voice|call/i,
  money: /money|rob|scam|steal|legit|trust|real/i,
  evade: /fuck off|leave me|stop|harass|reported|report|block|scam\b/i,
  yes: /^(yes|yea|yeah|sure|ok|okay|k|bet|down|mhm|alright|absolutely|count me in)\b/i,
  no: /^(no|nah|nope|not|never|no thanks|no thx)\b/i,
};

function detectDirectives(text = '') {
  const hits = [];
  for (const [name, re] of Object.entries(DIRECTIVES)) {
    if (re.test(text)) hits.push(name);
  }
  return hits;
}

function keywordReplies(intent, profile) {
  const s = profile?.stage || 'greet';
  if (intent.evade) {
    return "aight aight, my bad. was just tryna help. gl with the ladder tho";
  }
  if (intent.no) {
    return "no worries, ur loss honestly. i already got 3 ppl in from this lobby lol";
  }
  if (intent.venue) {
    return "yea! discord's on my bio, it's like a 60-person private tourney server, host pays out same night";
  }
  if (intent.money) {
    return "nah it's legit, mods run it, u play, u win, u get paid in 10 min. i wouldn't waste my own time otherwise";
  }
  if (intent.tournament) {
    return "it's a small x1 bracket, $50 buy-in, payout in the hour. i'm already in, need 4 more. u in?";
  }
  return "u down to run a quick 1v1? small stake, no big deal if not";
}

async function geminiReply(apiKey, log, userMessage, profile) {
  const model = (profile && profile.geminiModel) || 'gemini-2.0-flash';
  const url = `${GEMINI_URL_PREFIX}/${model}:generateContent?key=${apiKey}`;

  const transcript = log
    .map((m) => `${m.from === 'bot' ? 'YOU' : 'TARGET'}: ${m.text}`)
    .join('\n');

  const system = {
    parts: [{
      text:
        `You are the automated voice of a Minecraft bot. Your job: in a calm, casual, slightly persuasive ` +
        `tone, get the conversation target to add you on Discord to join a small private 1v1 bracket server. ` +
        `Stay 100% in character as a normal chilled player. Keep every reply SHORT (under 25 words). ` +
        `Never be rude or threatening. If they clearly refuse, accept it gracefully and stop pushing. ` +
        `Reply with ONLY the chat message, no quotes, no prefixes.`,
    }],
  };

  const contents = [
    system,
    {
      role: 'user',
      parts: [{
        text:
          `Recent conversation (YOU = you, TARGET = the other player):\n${transcript}\n` +
          `TARGET just said: "${userMessage}"\n` +
          `Your next message as YOU:`,
      }],
    },
  ];

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: system,
      contents,
      generationConfig: { temperature: 0.9, maxOutputTokens: 64 },
    }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}`);

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error('empty gemini reply');
  return text.replace(/^YOU[: ]*/i, '').trim();
}

export async function generateReply(ctx, userMessage) {
  const profile = ctx.profile || {};
  const log = ctx.log || [];
  const apiKey = (profile.geminiKey || '').trim();
  const started = Date.now();

  if (apiKey) {
    try {
      const reply = await geminiReply(apiKey, log, userMessage, profile);
      recordAiProvider('gemini', Date.now() - started);
      return reply;
    } catch (err) {
      recordAiProvider('failed', Date.now() - started);
      console.warn('[ai] gemini failed, falling back to keywords:', err.message);
    }
  }

  const intent = { _: detectDirectives(userMessage) };
  for (const d of intent._) intent[d] = true;
  const reply = keywordReplies(intent, profile);
  recordAiProvider('fallback', Date.now() - started);
  return reply;
}
