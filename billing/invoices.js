import { randomUUID } from 'node:crypto';
import { store } from '../store/index.js';
import { config } from '../config.js';
import { planById } from '../plans.js';
import { addressForInvoice, qrUri, qrDataUrl, BLOCKCYPHER_BASE } from './ltc.js';

const SATS = 1e8;

export function ltcAmount(usd, rate = config.ltcUsdRate) {
  return usd / rate;
}

/**
 * Create a new invoice for a paid plan. Derives a fresh LTC receive address
 * per invoice (BIP44). Persists via the file store.
 */
export async function createInvoice(planId, email = '', opts = {}) {
  const plan = planById(planId);
  if (!plan) throw new Error('unknown plan');
  if (plan.custom) throw new Error('custom plans use a separate flow');

  const all = store.invoices.all();
  const index = all.length;
  const { address } = addressForInvoice(index);
  const amountUsd = opts.amountUsd != null ? opts.amountUsd : plan.priceUsd;
  const amountLtc = ltcAmount(amountUsd);

  const invoice = {
    id: `inv_${randomUUID().slice(0, 12)}`,
    planId,
    email,
    amountUsd,
    amountLtc: Number(amountLtc.toFixed(6)),
    address,
    index,
    uri: qrUri(address, amountLtc),
    qr: await qrDataUrl(qrUri(address, amountLtc)),
    status: 'pending',
    created: Date.now(),
    paidAt: null,
    tx: null,
    confirmations: 0,
    // Credit top-up tags (absent for normal plan invoices):
    ...(opts.kind ? { creditKind: opts.kind, creditAmount: opts.credits || 0 } : {}),
  };
  store.invoices.save([...all, invoice]);
  return invoice;
}

export function getInvoice(id) {
  return store.invoices.all().find((i) => i.id === id) || null;
}

export function listInvoices() {
  return store.invoices.all();
}

function persist(invoice) {
  const all = store.invoices.all().map((i) => (i.id === invoice.id ? invoice : i));
  store.invoices.save(all);
}

export function markPaid(invoice, txHash, confirmations, grantFn) {
  if (invoice.status === 'paid') return invoice;
  invoice.status = 'paid';
  invoice.paidAt = Date.now();
  invoice.tx = txHash || invoice.tx;
  invoice.confirmations = confirmations != null ? confirmations : invoice.confirmations;
  persist(invoice);
  if (grantFn) grantFn(invoice);
  return invoice;
}

/**
 * Check a single address via BlockCypher for incoming funding.
 * Returns { ok, tx, value, confirmations } or throws on transport error.
 */
export async function checkAddress(address) {
  const url = `${BLOCKCYPHER_BASE}/addrs/${address}?unspentOnly=false${
    config.blockcypherToken ? `&token=${config.blockcypherToken}` : ''
  }`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`blockcypher ${res.status}`);
  const data = await res.json();
  const incoming = (data.txrefs || []).filter((t) => t.value > 0);
  const best = incoming.sort((a, b) => b.value - a.value)[0] || null;
  if (!best) return { ok: false };
  return {
    ok: true,
    tx: best.tx_hash,
    value: best.value / SATS,
    confirmations: best.confirmations || 0,
  };
}

/**
 * Auto-cancel pending invoices older than the TTL. Keeps the receive address
 * (so late payments can still be honored within the grace window) and flags
 * the change for persistence.
 */
export function cancelStaleInvoices({ afterMs = config.invoiceTtlMs } = {}) {
  const now = Date.now();
  const changed = [];
  for (const inv of store.invoices.all()) {
    if (inv.status === 'pending' && inv.created && now - inv.created > afterMs) {
      inv.status = 'cancelled';
      inv.cancelledAt = now;
      changed.push(inv);
    }
  }
  if (changed.length) {
    store.invoices.save(store.invoices.all());
    console.log(`[billing] auto-cancelled ${changed.length} stale invoice${changed.length === 1 ? '' : 's'}`);
  }
  return changed;
}

const onGrants = new Map(); // invoiceId -> fn(invoice)
let onStatus = null; // fn(invoice, result) -> live status hook

/**
 * Poll every pending + active invoice. When the on-chain balance meeting the
 * required amount is seen (at the configured confirmation depth), the invoice
 * is auto-cleared and the grant callback runs (provisions the subscription).
 *
 * BlockCypher free tier is tightly rate-limited (HTTP 429). To avoid hammering
 * the API and spamming logs, a global cooldown is applied after a 429/5xx:
 * while backed off, no BlockCypher calls are made and the error is logged at
 * most once per cooldown window.
 */
export function startWatcher({ pollMs = 10_000, grant, status } = {}) {
  onStatus = status || null;
  const seenFound = new Map(); // invoiceId -> {tx, conf} once we saw funding
  let blockedUntil = 0;
  let lastBlockedLog = 0;
  const BLOCK_COOLDOWN = 60_000; // back off a full minute on rate limit
  setInterval(async () => {
    // 1) Auto-cancel stale pending invoices (failed-send protection).
    cancelStaleInvoices();

    // 2) Watch pending invoices AND recently-cancelled ones (grace window) so
    //    a payment that lands late is still honored, never stranded.
    const now = Date.now();
    const pending = store.invoices.all().filter((i) =>
      i.status === 'pending' ||
      (i.status === 'cancelled' && now - (i.cancelledAt || i.created || now) < config.invoiceGraceMs),
    );
    if (!pending.length) return;

    if (now < blockedUntil) {
      // Still backed off from a prior 429/5xx — stay quiet, avoid the API.
      if (now - lastBlockedLog > BLOCK_COOLDOWN) {
        console.warn(`[billing] blockcypher backoff active, pausing checks until ${new Date(blockedUntil).toISOString()}`);
        lastBlockedLog = now;
      }
      return;
    }

    for (const inv of pending) {
      let result;
      try {
        result = await checkAddress(inv.address);
      } catch (e) {
        const statusCode = /([45]\d\d)/.exec(e.message)?.[1] || 'err';
        // Only a 429/5xx warrants a full cooldown; log transient 429s once.
        if (statusCode === '429' || statusCode.startsWith('5')) {
          blockedUntil = Date.now() + BLOCK_COOLDOWN;
          console.warn(`[billing] blockcypher rate-limit (${statusCode}) — backing off ${BLOCK_COOLDOWN / 1000}s`);
        } else {
          console.warn('[billing] blockcypher check failed:', e.message);
        }
        break;
      }
      if (!result.ok) continue;

      const needed = inv.amountLtc;
      const ok = result.value >= needed && result.confirmations >= config.confirmationsRequired;

      // Publish live status updates toward the dashboard via a callback hook.
      if (onStatus) onStatus(inv, result);

      if (ok) {
        const wasCancelled = inv.status === 'cancelled';
        const granted = markPaid(inv, result.tx, result.confirmations, (paid) => {
          if (grant) grant(paid);
          if (onGrants.has(paid.id)) onGrants.get(paid.id)(paid);
        });
        console.log(
          wasCancelled
            ? `[billing] invoice ${inv.id} LATE PAYMENT honored (${result.value} LTC, ${result.confirmations} conf)`
            : `[billing] invoice ${inv.id} PAID (${result.value} LTC, ${result.confirmations} conf)`,
        );
        void granted;
      } else {
        console.log(
          `[billing] invoice ${inv.id}: ${result.value}/${needed} LTC, ${result.confirmations}/${config.confirmationsRequired} conf`,
        );
      }
    }
  }, pollMs);
  return (id, fn) => onGrants.set(id, fn);
}
