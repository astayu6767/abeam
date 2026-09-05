import net from 'node:net';

const DEFAULT_PORT = 25565;
const PACKET_TIMEOUT_MS = 4000;

// Encode a signed varint (MSB continuation format).
function writeVarInt(value) {
  const out = [];
  let v = value;
  while (true) {
    if ((v & ~0x7f) === 0) {
      out.push(v & 0x7f);
      break;
    }
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(out);
}

// Read one varint from a buffer at the given offset.
function readVarInt(buf, offset) {
  let num = 0;
  let shift = 0;
  let pos = offset;
  while (true) {
    if (pos >= buf.length) return { value: null, bytes: 0 };
    const b = buf[pos++];
    num |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) return { value: null, bytes: 0 };
  }
  return { value: num >>> 0, bytes: pos - offset };
}

// Encode a length-prefixed packet.
function packet(payload) {
  const len = writeVarInt(payload.length);
  return Buffer.concat([len, payload]);
}

function encodeString(str) {
  const body = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(body.length), body]);
}

// Recursively flatten the chat-component JSON Minecraft uses for descriptions.
function flattenChat(node, acc = []) {
  if (node == null) return;
  if (typeof node === 'string') { acc.push(node); return; }
  if (Array.isArray(node)) { node.forEach((n) => flattenChat(n, acc)); return; }
  if (typeof node === 'object') {
    if (node.text != null) acc.push(String(node.text));
    if (node.extra) flattenChat(node.extra, acc);
  }
}

// Strip formatting codes, collapsing any nested chat-component JSON.
function stripFormatting(input) {
  if (input == null) return '';
  if (typeof input === 'object') {
    const acc = [];
    flattenChat(input, acc);
    return acc.join('').replace(/\u00a7[0-9a-fk-or]/gi, '').trim();
  }
  let s = String(input);
  if (s.trim()[0] === '{') {
    try {
      const acc = [];
      flattenChat(JSON.parse(s), acc);
      s = acc.join('');
    } catch {}
  }
  return s.replace(/\u00a7[0-9a-fk-or]/gi, '').trim();
}

function stripMotd(input) {
  return stripFormatting(input);
}

/**
 * Ping a Minecraft Java server for its status (modern Server List Ping).
 * @param {string} hostPort - "host:port" or just "host".
 * @returns {Promise<{online: boolean, host: string, port: number, version?: string, protocol?: number, players?: {online: number, max: number}, motd?: string, latency?: number, error?: string}>}
 */
export function pingServer(hostPort) {
  return new Promise((resolve) => {
    const host = String(hostPort || '').trim();
    const colon = host.lastIndexOf(':');
    let serverHost = host;
    let port = DEFAULT_PORT;
    if (colon > 0 && /^[0-9]+$/.test(host.slice(colon + 1))) {
      serverHost = host.slice(0, colon);
      port = Number(host.slice(colon + 1));
    } else if (colon === -1 && host.includes('.')) {
      serverHost = host;
    }

    if (!serverHost) {
      return resolve({ online: false, host: hostPort || '', port, error: 'no host' });
    }

    // ---- handshake packet (protocol 47 - 1.8; universally accepted) ----
    const hostPayload = encodeString(serverHost);
    const handshakeBody = Buffer.concat([
      writeVarInt(0),         // packet id: handshake
      writeVarInt(47),        // protocol version
      hostPayload,            // server host
      writeVarInt(port),      // server port
      writeVarInt(1),         // next state: status
    ]);
    const handshake = packet(handshakeBody);

    // ---- status request packet ----
    const statusReq = packet(writeVarInt(0));

    const start = Date.now();
    const sock = net.connect({ host: serverHost, port }, () => {
      sock.write(handshake);
      sock.write(statusReq);
    });

    const chunks = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ online: false, host: serverHost, port, error: 'timeout' });
    }, PACKET_TIMEOUT_MS);

    sock.on('data', (buf) => {
      chunks.push(buf);
      try {
        const all = Buffer.concat(chunks);
        const pktLen = readVarInt(all, 0);
        if (pktLen.value == null) return;
        const total = pktLen.bytes + pktLen.value;
        if (all.length < total) return;
        const off = pktLen.bytes;
        const pid = readVarInt(all, off);
        if (pid.value !== 0) return;
        const strOff = off + pid.bytes;
        const strLen = readVarInt(all, strOff);
        if (strLen.value == null) return;
        const bodyStart = strOff + strLen.bytes;
        const bodyEnd = bodyStart + strLen.value;
        if (all.length < bodyEnd) return;
        const json = all.toString('utf8', bodyStart, bodyEnd);
        const data = JSON.parse(json);
        const latency = Date.now() - start;
        clearTimeout(timer);
        finish({
          online: true,
          host: serverHost,
          port,
          version: stripFormatting(data.version?.name),
          protocol: data.version?.protocol,
          players: data.players ? { online: data.players.online, max: data.players.max } : undefined,
          motd: stripMotd(data.description),
          latency,
        });
      } catch {
        // partial data — wait for more
      }
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      finish({ online: false, host: serverHost, port, error: err.code || err.message });
    });

    sock.on('close', () => {
      clearTimeout(timer);
      if (!settled) finish({ online: false, host: serverHost, port, error: 'closed' });
    });
  });
}

/**
 * Ping a list of (possibly duplicate) servers; returns { serverAddr: status }.
 */
export async function pingServers(addresses) {
  const unique = [...new Set(addresses.filter(Boolean))];
  const results = await Promise.allSettled(unique.map((a) => pingServer(a)));
  const map = {};
  unique.forEach((a, i) => {
    map[a] = results[i].status === 'fulfilled' ? results[i].value : { online: false, host: a, error: 'failed' };
  });
  return map;
}
