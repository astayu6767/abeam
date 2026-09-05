import { config } from '../config.js';

/**
 * Discord match log ("Beam Logging"). Every subscriber can enable this per
 * bot: when a slot starts a conversation ("match") with a player, an embed
 * carrying the player IGN + skin head is posted to that slot's webhook URL.
 * The URL comes from the slot's own config; the global WEBHOOK_URL acts as a
 * fallback for the operator. Best-effort: logs failures, never throws.
 *
 * @param {{webhookUrl?:string, target:string, botName?:string, server?:string, mode?:string}} opts
 */
export async function postMatchStart({ webhookUrl = '', target, botName, server, mode }) {
  const url = String(webhookUrl || config.webhookUrl || '').trim();
  if (!url || !target) return;
  const embed = {
    title: `🎯 Match started · ${target}`,
    color: 0x5865f2,
    thumbnail: { url: `https://mc-heads.net/avatar/${encodeURIComponent(target)}/64.png` },
    fields: [
      { name: 'Bot', value: botName || '—', inline: true },
      { name: 'Server', value: server || '—', inline: true },
      { name: 'Mode', value: String(mode || 'sword').toUpperCase(), inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'abeam', embeds: [embed] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error(`[webhook] match log non-2xx from Discord: ${res.status}`);
  } catch (e) {
    console.error(`[webhook] match log failed to post: ${e?.message || e}`);
  }
}

/**
 * Build and send a Discord webhook "devlog" entry.
 *
 * @param {string} title   Short heading, e.g. "Plans & billing".
 * @param {string} body    The details / changelog text.
 * @param {{color?:number, tag?:string, images?:string[]}} [opts]
 *   images — array of image URLs to append as separate embeds.
 */
export async function logDevlog(title, body, opts = {}) {
  const url = config.devlogWebhookUrl;
  if (!url || !title) return;
  const embed = {
    title,
    description: String(body),
    color: opts.color != null ? opts.color : 0x22c55e,
    footer: { text: `abeam · ${new Date().toISOString()}` },
  };
  const embeds = [embed];
  if (Array.isArray(opts.images)) {
    for (const imgUrl of opts.images) {
      if (!imgUrl) continue;
      embeds.push({ image: { url: imgUrl } });
    }
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'abeam',
        content: opts.tag ? `**${opts.tag}**` : undefined,
        embeds,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[webhook] devlog non-2xx from Discord: ${res.status}`);
    }
  } catch (e) {
    console.error(`[webhook] devlog failed to post: ${e?.message || e}`);
  }
}
