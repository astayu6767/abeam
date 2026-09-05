import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Node-side controller for the Azalea JSON-lines sidecar.
 *
 * The Rust binary is compiled from azalea-bridge/ and speaks one JSON object
 * per line on stdin/stdout. Keeping this adapter separate from manager.js
 * makes the runtime engine replaceable without changing the HTTP API.
 */

const noisyLines = new Set();

function filterAzaleaLog(line) {
  const lower = String(line).toLowerCase();
  if (lower.includes('error reading packet') || lower.includes('failed to fill whole buffer')) {
    if (noisyLines.has(line)) return true;
    if (noisyLines.size > 400) noisyLines.clear();
    noisyLines.add(line);
    return false;
  }
  return [
    'more than 1,000 items',
    'packet-event',
    'explode (id 36)',
    'packet explode',
    'azalea_client::plugins::connection',
    'azalea sending command:',
    'azalea sending chat:',
    'chat sent: cmd',
    'chat sent: msg',
  ].some((part) => lower.includes(part));
}

function findAzaleaBinary() {
  const candidates = [
    process.env.AZALEA_BRIDGE_BIN,
    '/usr/local/bin/azalea-bridge',
    path.join(process.cwd(), 'azalea-bridge', 'target', 'release', 'azalea-bridge'),
    path.join(process.cwd(), 'bin', 'azalea-bridge'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function clampLine(line) {
  return String(line || '').trim().slice(0, 1200);
}

export class AzaleaHandle extends EventEmitter {
  constructor(child, username) {
    super();
    this.child = child;
    this.username = username;
    this.using = false;
    this.entity = null;
    this.health = 20;
    this.food = 20;
    this.inventory = { slots: [] };
    this.quickBarSlot = 0;
    this.heldItem = null;
    this.currentWindow = null;
    this.physicsEnabled = false;
    this.version = '26.1';
    this.players = {};
    this.snapshot = null;
  }

  send(payload) {
    try {
      if (this.child.stdin && !this.child.stdin.destroyed) {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      }
    } catch {
      // The child may be exiting.
    }
  }

  chat(message) {
    this.send({ op: 'chat', text: String(message) });
  }

  quit() {
    this.send({ op: 'disconnect' });
    try { this.child.kill('SIGTERM'); } catch {}
  }

  end() {
    this.quit();
  }

  setControlState(direction, on) {
    const dir = {
      forward: 'forward',
      back: 'back',
      left: 'left',
      right: 'right',
      sneak: 'sneak',
      jump: 'jump',
    }[direction] || direction;
    if (dir === 'jump' && on) {
      this.send({ op: 'jump' });
      return;
    }
    if (dir === 'sneak') {
      this.send({ op: 'sneak', on: !!on });
      return;
    }
    this.send({ op: 'walk', dir, on: !!on, ms: on ? 600 : 0 });
  }

  clearControlStates() {
    this.send({ op: 'walk', dir: 'none', on: false });
    this.send({ op: 'sneak', on: false });
  }

  async setQuickBarSlot(slot) {
    this.quickBarSlot = Number(slot) || 0;
    this.send({ op: 'select', slot: this.quickBarSlot });
  }

  activateItem() {
    this.using = true;
    this.send({ op: 'use' });
  }

  deactivateItem() {
    this.using = false;
    this.send({ op: 'use_stop' });
  }

  async consume() {
    this.activateItem();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    this.deactivateItem();
  }

  async tossStack() {
    this.send({ op: 'drop' });
  }

  clickWindow(slot) {
    this.send({ op: 'clickWindow', slot: Number(slot) });
  }

  closeWindow() {
    this.send({ op: 'closeWindow' });
  }

  look() {
    this.send({ op: 'look' });
  }

  nearestEntity() {
    return null;
  }
}

function updateHandleFromSnapshot(handle, snapshot) {
  handle.snapshot = snapshot;
  handle.entity = {
    position: snapshot.position || { x: 0, y: 0, z: 0 },
    yaw: Number(snapshot.yaw || 0),
    pitch: Number(snapshot.pitch || 0),
  };
  handle.health = Number(snapshot.health ?? 20);
  handle.food = Number(snapshot.food ?? 20);
  handle.quickBarSlot = Number(snapshot.selectedSlot ?? 0);
  handle.heldItem = snapshot.heldItem
    ? { name: snapshot.heldItem, displayName: snapshot.heldItem, count: 1 }
    : null;
  handle.currentWindow = snapshot.window || null;
  handle.inventory = { slots: snapshot.hotbar || [] };
}

/**
 * Start an Azalea process for one persisted bot record.
 * Callbacks are deliberately small and map directly to manager runtime state.
 */
export async function startAzaleaBot(record, runtime, callbacks = {}) {
  const binary = findAzaleaBinary();
  if (!binary) {
    callbacks.onError?.(
      'Azalea engine selected, but azalea-bridge is missing. Build the Docker image with the Rust sidecar.',
    );
    return false;
  }

  let child;
  try {
    child = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, RUST_LOG: process.env.RUST_LOG || 'warn' },
    });
  } catch (error) {
    callbacks.onError?.(`failed to spawn Azalea bridge: ${error?.message || error}`);
    return false;
  }

  const handle = new AzaleaHandle(child, record.username || record.name || 'cloubot');
  runtime.azaleaChild = child;
  runtime.azaleaRespawn = false;
  runtime.azaleaHbAt = Date.now();
  runtime.azaleaHbTickAgeS = null;
  runtime.azaleaHbOnline = false;
  runtime.bot = handle;

  let ended = false;
  const emitEnd = (reason) => {
    if (ended) return;
    ended = true;
    callbacks.onEnd?.(reason || 'azalea exited');
  };

  runtime.azaleaHbWatcher = setInterval(() => {
    if (runtime.manualStop || !runtime.azaleaChild) return;
    const heartbeatAge = Date.now() - (runtime.azaleaHbAt || Date.now());
    const tickAge = runtime.azaleaHbTickAgeS ?? 0;
    let reason = '';
    if (heartbeatAge > 20_000) {
      reason = `Azalea heartbeat lost (${Math.round(heartbeatAge / 1000)}s)`;
    } else if (runtime.azaleaHbOnline && tickAge >= 45) {
      reason = `Azalea client stalled for ${tickAge}s`;
    }
    if (!reason || Date.now() - (runtime.azaleaLastRestart || 0) < 60_000) return;
    runtime.azaleaLastRestart = Date.now();
    callbacks.onError?.(`${reason}; restarting sidecar`);
    try { child.kill('SIGKILL'); } catch {}
  }, 5000);

  const startMessage = {
    op: 'start',
    host: record.host,
    port: record.port,
    username: record.username,
    uuid: record.uuid,
    token: record.token,
    proxy: record.proxy || '',
  };

  const writeStart = () => {
    try {
      child.stdin?.write(`${JSON.stringify(startMessage)}\n`);
    } catch (error) {
      callbacks.onError?.(`failed to initialize Azalea: ${error?.message || error}`);
    }
  };
  if (child.stdin) writeStart();
  else child.once('spawn', writeStart);

  const onLine = (raw) => {
    const line = clampLine(raw);
    if (!line) return;
    if (filterAzaleaLog(line)) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      callbacks.onLog?.('system', line);
      return;
    }

    switch (message.ev) {
      case 'log':
        callbacks.onLog?.(message.level || 'system', clampLine(message.line));
        break;
      case 'chat': {
        const text = clampLine(message.line);
        callbacks.onLog?.('chat', text);
        callbacks.onChat?.(text);
        handle.emit('messagestr', text);
        break;
      }
      case 'status':
        callbacks.onStatus?.(message.status, handle);
        break;
      case 'error': {
        const text = clampLine(message.line || 'Azalea error');
        callbacks.onError?.(text);
        handle.emit('kicked', text);
        break;
      }
      case 'death':
        callbacks.onLog?.('system', 'Bot died.');
        handle.emit('death');
        break;
      case 'player_add':
        if (message.name) {
          handle.players[message.name] = { username: message.name };
          callbacks.onPlayerAdded?.(message.name, handle);
          handle.emit('playerJoined', { username: message.name });
        }
        break;
      case 'player_remove':
        if (message.name) {
          delete handle.players[message.name];
          callbacks.onPlayerRemoved?.(message.name, handle);
          handle.emit('playerLeft', { username: message.name });
        }
        break;
      case 'snapshot':
        updateHandleFromSnapshot(handle, message);
        callbacks.onSnapshot?.(message, handle);
        break;
      case 'hb':
        runtime.azaleaHbAt = Date.now();
        runtime.azaleaHbOnline = message.online === true;
        runtime.azaleaHbTickAgeS = typeof message.tick_age_s === 'number' ? message.tick_age_s : null;
        break;
      case 'end':
        emitEnd(message.line || 'azalea ended');
        break;
      default:
        break;
    }
  };

  if (child.stdout) {
    const output = readline.createInterface({ input: child.stdout });
    output.on('line', onLine);
  }
  if (child.stderr) {
    const errors = readline.createInterface({ input: child.stderr });
    errors.on('line', (line) => {
      const text = clampLine(line);
      if (text && !filterAzaleaLog(text)) callbacks.onLog?.('system', `[azalea] ${text}`);
    });
  }

  child.on('error', (error) => {
    callbacks.onError?.(`Azalea bridge error: ${error?.message || error}`);
    emitEnd(error?.message || 'azalea process error');
  });
  child.on('exit', (code, signal) => {
    if (runtime.azaleaChild === child) runtime.azaleaChild = null;
    if (runtime.azaleaHbWatcher) {
      clearInterval(runtime.azaleaHbWatcher);
      runtime.azaleaHbWatcher = null;
    }
    emitEnd(`Azalea process exited (code=${code ?? '?'} signal=${signal || 'none'})`);
  });

  callbacks.onStarted?.(handle, binary);
  return true;
}

export function stopAzaleaBot(runtime) {
  if (runtime.azaleaHbWatcher) {
    clearInterval(runtime.azaleaHbWatcher);
    runtime.azaleaHbWatcher = null;
  }
  runtime.azaleaRespawn = false;
  const child = runtime.azaleaChild;
  runtime.azaleaChild = null;
  if (!child) return;
  try { child.kill('SIGTERM'); } catch {}
}
