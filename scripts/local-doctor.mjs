import net from 'node:net';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Minecraft's status exchange is read-only: no login, world edits, or bot entity.
function varint(number) {
  const bytes = [];
  do { let byte = number & 0x7f; number >>>= 7; if (number) byte |= 0x80; bytes.push(byte); } while (number);
  return Buffer.from(bytes);
}
function readVarint(buffer, offset = 0) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buffer.length) return null;
    const byte = buffer[offset + i]; value |= (byte & 0x7f) << (7 * i);
    if (!(byte & 0x80)) return { value, end: offset + i + 1 };
  }
  throw new Error('Invalid status VarInt');
}
async function ping(port, protocol) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0); let completed = false;
    const fail = error => { if (!completed) { completed = true; socket.destroy(); reject(error); } };
    socket.setTimeout(5000, () => fail(new Error('Status timeout')));
    socket.on('error', fail);
    socket.on('end', () => { if (!completed) fail(new Error('Connection closed before status response')); });
    socket.on('connect', () => {
      const host = Buffer.from('127.0.0.1'); const portBytes = Buffer.alloc(2); portBytes.writeUInt16BE(port);
      const handshake = Buffer.concat([varint(0), varint(protocol), varint(host.length), host, portBytes, varint(1)]);
      socket.write(Buffer.concat([varint(handshake.length), handshake, Buffer.from([1, 0])]));
    });
    socket.on('data', chunk => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        const length = readVarint(buffer); if (!length) return;
        if (length.value < 0 || length.value > 2 * 1024 * 1024) throw new Error('Invalid status frame length');
        if (buffer.length < length.end + length.value) return;
        const packet = readVarint(buffer, length.end); if (!packet || packet.value !== 0) throw new Error('Unexpected status packet');
        const text = readVarint(buffer, packet.end);
        if (!text || text.value < 0 || text.end + text.value > length.end + length.value) throw new Error('Invalid status JSON length');
        const status = JSON.parse(buffer.subarray(text.end, text.end + text.value).toString('utf8'));
        completed = true; socket.destroy();
        resolve({ address: `127.0.0.1:${port}`, reachable: true, requestedProtocol: protocol, version: status.version,
          players: status.players, description: status.description, latencyMs: Date.now() - started });
      } catch (error) { fail(error); }
    });
  });
}
const targets = [
  { name: 'localServer', port: Number(process.env.MC_LOCAL_SERVER_PORT || 25567), protocol: 769 },
  { name: 'nativeClientProxy', port: Number(process.env.MC_LOCAL_PROXY_PORT || 25568), protocol: 777 },
];
const status = await Promise.all(targets.map(async target => {
  try { return { name: target.name, ...await ping(target.port, target.protocol) }; }
  catch (error) { return { name: target.name, address: `127.0.0.1:${target.port}`, reachable: false, error: error.message }; }
}));
const versionsDirectory = process.env.APPDATA && resolve(process.env.APPDATA, '.minecraft/versions');
const clients = [];
if (versionsDirectory && existsSync(versionsDirectory)) for (const entry of readdirSync(versionsDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try {
    const json = JSON.parse(readFileSync(resolve(versionsDirectory, entry.name, `${entry.name}.json`), 'utf8'));
    clients.push({ version: json.id, type: json.type, requiredJava: json.javaVersion?.majorVersion });
  } catch {}
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), clients, endpoints: status,
  connect: { '1.21.4': `127.0.0.1:${targets[0].port}`, '26.3': `127.0.0.1:${targets[1].port}` },
  note: 'Status ping verifies protocol availability. A successful native game login and visible world are separate checks.' }, null, 2));
if (status.some(endpoint => !endpoint.reachable)) process.exitCode = 1;
