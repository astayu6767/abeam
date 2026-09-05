import * as ecc from 'tiny-secp256k1';
import { BIP32Factory } from 'bip32';
import * as bitcoin from 'bitcoinjs-lib';
import { mnemonicToSeedSync } from 'bip39';
import QRCode from 'qrcode';
import { config } from '../config.js';

const bip32 = BIP32Factory(ecc);

// Litecoin network params (BIP44 coin type 2).
export const LITECOIN = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: { public: 0x019da462, private: 0x019d9cfe },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

// Litecoin testnet params (for faucet-funded end-to-end sweep tests).
export const LITECOIN_TEST = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'tltc',
  bip32: { public: 0x043587cf, private: 0x04358394 },
  pubKeyHash: 0x6f,
  scriptHash: 0x3a,
  wif: 0xef,
};

export const NETWORKS = { main: LITECOIN, test: LITECOIN_TEST };
export const LTC_NETWORK = NETWORKS[config.ltcNetwork] || LITECOIN;
export const BLOCKCYPHER_BASE =
  config.ltcNetwork === 'test'
    ? 'https://api.blockcypher.com/v1/ltc/test'
    : 'https://api.blockcypher.com/v1/ltc/main';
export const EXPLORER_BASE =
  config.ltcNetwork === 'test' ? 'https://sochain.com/tx/LTCTEST/' : 'https://sochain.com/tx/LTC/';

export class LtcWallet {
  constructor(seedOrPhrase) {
    if (!seedOrPhrase) throw new Error('LTC_SEED is not configured');
    let seed;
    if (seedOrPhrase.split(' ').length > 1) {
      seed = mnemonicToSeedSync(seedOrPhrase);
    } else {
      seed = Buffer.from(seedOrPhrase, 'hex');
    }
    this.root = bip32.fromSeed(seed);
  }

  /** Derive a fresh receiving address for an invoice: m/44'/2'/0'/0/<index> */
  deriveAddress(index) {
    const child = this.root.derivePath(`m/44'/2'/0'/0/${index}`);
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(child.publicKey),
      network: LTC_NETWORK,
    });
    return { address, index };
  }
}

let wallet;
export function getWallet() {
  if (wallet) return wallet;
  let seed = config.ltcSeed;
  // Dev fallback so local checkout/testing works without configuring a seed.
  // NEVER used in production — an empty LTC_SEED throws there.
  if (!seed && config.env !== 'production') {
    seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  }
  wallet = new LtcWallet(seed);
  return wallet;
}

export function addressForInvoice(index) {
  return getWallet().deriveAddress(index);
}

/** QR encodes `litecoin:<addr>?amount=<n>` — scannable in most wallets. */
export function qrUri(address, amountLtc) {
  return `litecoin:${address}?amount=${amountLtc.toFixed(6)}`;
}

export async function qrDataUrl(uri) {
  return await QRCode.toDataURL(uri, { width: 220, margin: 1 });
}
