import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

function load(fname, fallback) {
  const file = path.join(DATA_DIR, fname);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function save(fname, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, fname);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return data;
}

/**
 * Tiny JSON document store. Good enough for a self-hosted tool; swap for a
 * real DB (Postgres/Redis) when scaling.
 */
export const store = {
  users: {
    all: () => load('users.json', []),
    save: (u) => save('users.json', u),
  },
  passwords: {
    all: () => load('passwords.json', {}),
    save: (p) => save('passwords.json', p),
  },
  sessions: {
    all: () => load('sessions.json', {}),
    save: (s) => save('sessions.json', s),
  },
  conversations: {
    all: () => load('conversations.json', []),
    save: (c) => save('conversations.json', c),
  },
  invoices: {
    all: () => load('invoices.json', []),
    save: (i) => save('invoices.json', i),
  },
  subscribers: {
    all: () => load('subscribers.json', {}),
    save: (s) => save('subscribers.json', s),
  },
  licenses: {
    all: () => load('licenses.json', []),
    save: (l) => save('licenses.json', l),
  },
  config: {
    all: () => load('config.json', {}),
    save: (c) => save('config.json', c),
  },
  walletLedger: {
    all: () => load('wallet-ledger.json', []),
    save: (l) => save('wallet-ledger.json', l),
  },
};
