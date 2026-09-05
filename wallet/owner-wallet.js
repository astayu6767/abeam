import { randomUUID } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { LTC_NETWORK, getWallet, BLOCKCYPHER_BASE, EXPLORER_BASE } from '../billing/ltc.js';
import { store } from '../store/index.js';
import { config } from '../config.js';

/**
 * Owner wallet: a stable receiving address (branch 1) that all invoice
 * balances are swept into, plus outgoing sends. Signing uses the same BIP44
 * seed as invoices (m/44'/2'/0'/1/0), keeps funds cold-ish in the HD tree.
 * On-chain reads + transaction broadcast go through BlockCypher.
 */

const OWNER_PATH = `m/44'/2'/0'/1/0`;
const API = BLOCKCYPHER_BASE;
const SATS = 1e8;

// ── Live LTC price (CoinGecko, cached 60 s) ────────────────────────────────
let _ltcPrice = Number(config.ltcUsdRate) || 100;
let _ltcPriceAt = 0;
const PRICE_TTL = 60_000;

async function refreshLtcPrice() {
  if (Date.now() - _ltcPriceAt < PRICE_TTL) return _ltcPrice;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd', {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return _ltcPrice;
    const d = await r.json();
    if (d?.litecoin?.usd) { _ltcPrice = d.litecoin.usd; _ltcPriceAt = Date.now(); }
  } catch {}
  return _ltcPrice;
}

export function ltcPriceNow() { return _ltcPrice; }
export async function fetchLtcPrice() { await refreshLtcPrice(); return _ltcPrice; }

function ownerNode() {
  return getWallet().root.derivePath(OWNER_PATH);
}

export function ownerAddress() {
  return bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(ownerNode().publicKey),
    network: LTC_NETWORK,
  }).address;
}

/** Fresh deposits ledger record id. */
const newLedgerId = () => `wt_${randomUUID().slice(0, 10)}`;

async function bc(path, opts) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${API}/${path}${config.blockcypherToken ? `${sep}token=${config.blockcypherToken}` : ''}`;
  const res = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`blockcypher ${res.status}`);
  return res.json();
}

async function addrs(address, query = '') {
  return bc(`addrs/${address}${query}`);
}

/** Unspent outputs for an address (only those meeting min confirmations). */
async function unspentsFor(address) {
  const d = await addrs(address, '?unspentOnly=true');
  return (d.txrefs || [])
    .filter((t) => t.value > 0)
    .map((t) => ({
      tx_hash: t.tx_hash,
      tx_output_n: t.tx_output_n,
      value: t.value,
      confirmations: t.confirmations || 0,
      spent_by: t.spent_by || null,
    }));
}

function estimateFee(inputs, outputs) {
  const vbytes = 12 + inputs * 68 + outputs * 31;
  const perKb = Number(config.walletFeeSatsPerKb || 1500);
  return Math.max(1000, Math.ceil((vbytes / 1000) * perKb));
}

/**
 * bitcoinjs 6.x dropped ECPair; PSBT signing takes a Signer interface. Wrap
 * the HD node's key in a tiny-secp256k1-backed signer. tiny-secp256k1 and
 * bip32 both return Uint8Array, but bitcoinjs 6.1 demands Buffer.
 */
function toBuf(v) {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}
function toSigner(node) {
  const seckey = Buffer.from(node.privateKey);
  return {
    network: LTC_NETWORK,
    publicKey: Buffer.from(node.publicKey),
    sign: (hash) => toBuf(ecc.sign(hash, seckey)),
    signSchnorr: (hash) => toBuf(ecc.signSchnorr(hash, seckey)),
  };
}

/** Build + sign a segwit transaction spending the listed unspents. */
function buildAndSign(inputs, outputs, node) {
  const psbt = new bitcoin.Psbt({ network: LTC_NETWORK });
  const script = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(node.publicKey), network: LTC_NETWORK }).output;
  for (const inp of inputs) {
    psbt.addInput({ hash: inp.tx_hash, index: inp.tx_output_n, witnessUtxo: { value: inp.value, script } });
  }
  for (const out of outputs) psbt.addOutput(out);
  psbt.signAllInputs(toSigner(node));
  psbt.finalizeAllInputs();
  return psbt.extractTransaction();
}

async function push(hex) {
  const d = await bc('txs/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx: hex }),
  });
  if (!d?.tx?.hash) throw new Error(d?.error || 'broadcast failed');
  return d.tx.hash;
}

function isValidAddress(addr) {
  try {
    bitcoin.address.toOutputScript(String(addr).trim(), LTC_NETWORK);
    return true;
  } catch {
    return false;
  }
}

/** Owner wallet overview: balance, address, history (on-chain + ledger). */
export async function getWalletData() {
  const address = ownerAddress();
  let balanceSats = 0;
  let unconfirmedSats = 0;
  let onchain = [];
  try {
    const b = await addrs(address, '/balance');
    balanceSats = b.balance || 0;
    unconfirmedSats = b.unconfirmed_balance || 0;
  } catch {
    // balance endpoint can miss on empty wallets; treat as zero
  }
  try {
    const d = await addrs(address);
    onchain = (d.txrefs || [])
      .filter((t) => t.tx_hash)
      .map((t) => ({
        hash: t.tx_hash,
        value: t.value,
        confirmations: t.confirmations || 0,
        ts: t.confirmed ? Date.parse(t.confirmed) : Date.now(),
        spent: !!t.spent_by,
      }));
  } catch {}
  const ledger = store.walletLedger.all();
  const invoices = store.invoices.all();
  const sweepable = invoices.filter((i) => i.status === 'paid' && !i.swept).length;
  const price = await refreshLtcPrice();
  return {
    address,
    balanceSats,
    balanceLtc: Number((balanceSats / SATS).toFixed(8)),
    balanceUsd: Number(((balanceSats / SATS) * price).toFixed(2)),
    unconfirmedSats,
    unconfirmedLtc: Number((unconfirmedSats / SATS).toFixed(8)),
    unconfirmedUsd: Number(((unconfirmedSats / SATS) * price).toFixed(2)),
    ltcUsdRate: price,
    explorer: EXPLORER_BASE,
    sweepable,
    onchain,
    ledger: [...ledger].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 100),
  };
}

/** Sweep every paid-but-unswept invoice balance into the owner wallet. */
export async function sweepAll({ max = 6 } = {}) {
  const results = [];
  const invoices = store.invoices.all().filter((i) => i.status === 'paid' && !i.swept);
  const bucket = invoices.slice(0, max);
  for (const inv of bucket) {
    // Cooldown so empty invoice addresses aren't hammered every cycle.
    if (Date.now() - (inv.lastSweepAttempt || 0) < 5 * 60 * 1000) continue;
    inv.lastSweepAttempt = Date.now();
    try {
      const node = getWallet().root.derivePath(`m/44'/2'/0'/0/${inv.index}`);
      const unspents = (await unspentsFor(inv.address)).filter((u) => u.confirmations >= config.confirmationsRequired);
      if (!unspents.length) {
        persistInvoice(inv);
        continue;
      }
      const fee = estimateFee(unspents.length, 1);
      const total = unspents.reduce((s, u) => s + u.value, 0);
      if (total - fee <= 5460) { // below dust
        inv.swept = true;
        inv.sweepNote = 'below dust';
        persistInvoice(inv);
        continue;
      }
      const tx = buildAndSign(unspents, [{ address: ownerAddress(), value: total - fee }], node);
      const hash = await push(tx.toHex());
      inv.swept = true;
      inv.sweepTx = hash;
      inv.sweepAt = Date.now();
      inv.sweepLtc = Number(((total - fee) / SATS).toFixed(8));
      persistInvoice(inv);
      storeLedger({
        kind: 'sweep',
        tx: hash,
        from: inv.address,
        to: ownerAddress(),
        valueLtc: inv.sweepLtc,
        feeLtc: Number((fee / SATS).toFixed(8)),
        invoiceId: inv.id,
      });
      results.push({ ok: true, invoiceId: inv.id, tx: hash, valueLtc: inv.sweepLtc });
    } catch (e) {
      persistInvoice(inv);
      results.push({ ok: false, invoiceId: inv.id, error: e.message || 'sweep failed' });
    }
  }
  return results;
}

/** Send LTC out of the owner wallet. Validates address + balance. */
export async function sendFromWallet(to, sats) {
  const address = String(to || '').trim();
  if (!isValidAddress(address)) throw new Error('invalid LTC address');
  sats = Math.floor(Number(sats));
  if (!Number.isFinite(sats) || sats <= 0) throw new Error('invalid amount');

  const node = ownerNode();
  const unspents = await unspentsFor(ownerAddress());
  const usable = unspents.filter((u) => u.confirmations >= config.confirmationsRequired);
  if (!usable.length) throw new Error('no spendable funds in owner wallet');

  const chosen = [];
  let total = 0;
  for (const u of usable) {
    chosen.push(u);
    total += u.value;
    if (total >= sats + estimateFee(chosen.length, 2)) break;
  }
  if (total < sats + estimateFee(chosen.length, 2)) {
    const needs = Number(((sats + estimateFee(chosen.length, 2)) / SATS).toFixed(8));
    throw new Error(`insufficient funds (have ${Number((total / SATS).toFixed(8))} LTC, need ~${needs} LTC)`);
  }
  const fee = estimateFee(chosen.length, 2);
  const change = total - sats - fee;
  const outputs = [{ address, value: sats }];
  if (change > 5460) outputs.push({ address: ownerAddress(), value: change });

  const tx = buildAndSign(chosen, outputs, node);
  const hash = await push(tx.toHex());
  storeLedger({
    kind: 'send',
    tx: hash,
    from: ownerAddress(),
    to: address,
    valueLtc: Number((sats / SATS).toFixed(8)),
    feeLtc: Number((fee / SATS).toFixed(8)),
  });
  return { ok: true, tx: hash, valueLtc: Number((sats / SATS).toFixed(8)), feeLtc: Number((fee / SATS).toFixed(8)) };
}

function persistInvoice(inv) {
  const all = store.invoices.all().map((i) => (i.id === inv.id ? inv : i));
  store.invoices.save(all);
}

function storeLedger(entry) {
  const all = store.walletLedger.all();
  all.push({ id: newLedgerId(), at: Date.now(), ...entry });
  store.walletLedger.save(all);
}

/**
 * Periodically sweep any newly paid invoice balances into the owner wallet.
 * Runs immediately on boot, then on a quiet interval. Failures are logged and
 * retried on the next cycle (the per-invoice cooldown prevents hammering).
 */
export function startOwnerSweeper({ pollMs = 5 * 60 * 1000 } = {}) {
  const run = async (why) => {
    try {
      const results = await sweepAll();
      for (const r of results) {
        console.log(r.ok
          ? `[owner-wallet] swept ${r.valueLtc} LTC (invoice ${r.invoiceId}) -> ${r.tx}`
          : `[owner-wallet] sweep retry pending (invoice ${r.invoiceId}): ${r.error}`);
      }
    } catch (e) {
      console.warn(`[owner-wallet] sweep cycle (${why}) failed:`, e.message);
    }
  };
  setTimeout(() => run('boot'), 15_000);
  setInterval(() => run('tick'), pollMs);
}