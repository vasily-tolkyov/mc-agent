import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, appendFileSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
const directory = resolve(root, 'viaproxy');
const jar = resolve(directory, 'ViaProxy-3.4.13.jar');
const url = 'https://github.com/ViaVersion/ViaProxy/releases/download/v3.4.13/ViaProxy-3.4.13.jar';
const sha256 = '4bbb6a6b9d3dd6a2028773ed44b97a98751e4a48e416aaad4bf6d9c860083be9';
const java = process.env.MC_JAVA21 || 'D:/Kairos-Minecraft/runtime/jdk-21/bin/java.exe';
const port = Number(process.env.MC_LOCAL_PROXY_PORT || 25568);
const targetPort = Number(process.env.MC_LOCAL_SERVER_PORT || 25567);
const statePath = resolve(directory, 'supervisor.json');
const logPath = resolve(directory, 'console.log');
const lockPath = resolve(directory, 'supervisor.lock');
const command = process.argv[2] || 'status';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function readState() { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return null; } }
function verifyJar() {
  if (!existsSync(jar)) throw new Error('ViaProxy jar missing. Run: node scripts/local-proxy.mjs install');
  if (createHash('sha256').update(readFileSync(jar)).digest('hex') !== sha256) throw new Error('ViaProxy SHA-256 mismatch. The jar was not run.');
  if (!existsSync(java)) throw new Error(`Java 21 missing: ${java}`);
}
async function control(action) {
  const state = readState();
  if (!state) throw new Error('No managed proxy. Run: node scripts/local-proxy.mjs start');
  const response = await fetch(`http://127.0.0.1:${state.controlPort}/${action}`, {
    method: 'POST', headers: { authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`Control request failed: ${response.status}`);
  return response.json();
}
async function available() {
  await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
async function listening() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}
async function daemon() {
  verifyJar(); await available();
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    let alive = true;
    try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('A local proxy supervisor is already starting or running. Check status.');
    unlinkSync(lockPath);
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  process.on('exit', () => {
    try { if (JSON.parse(readFileSync(lockPath, 'utf8')).pid === process.pid) unlinkSync(lockPath); } catch {}
  });
  const token = randomBytes(32).toString('hex');
  let stopping = false;
  const child = spawn(java, ['-Xms128M', '-Xmx512M', '-jar', jar, 'cli',
    '--bind-address', `127.0.0.1:${port}`, '--target-address', `127.0.0.1:${targetPort}`,
    '--target-version', '1.21.4', '--proxy-online-mode', 'false', '--auth-method', 'NONE',
    '--wildcard-domain-handling', 'NONE',
  ], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = () => { if (!stopping) { stopping = true; child.kill(); } };
  const controller = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403); return response.end('{}'); }
    if (request.url === '/stop') { stop(); return response.end(JSON.stringify({ stopping: true })); }
    if (request.url === '/status') return response.end(JSON.stringify({
      service: 'kairos-local-proxy', ready: await listening(), stopping,
      version: '3.4.13', client: '26.3', address: `127.0.0.1:${port}`,
      target: `127.0.0.1:${targetPort}`, targetVersion: '1.21.4', pid: child.pid, logPath,
    }));
    response.writeHead(404); response.end('{}');
  });
  await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
  controller.requestTimeout = 5000; controller.headersTimeout = 5000;
  writeFileSync(statePath, JSON.stringify({ token, controlPort: controller.address().port, supervisorPid: process.pid, proxyPid: child.pid, startedAt: new Date().toISOString() }, null, 2));
  const onOutput = chunk => appendFileSync(logPath, chunk.toString().replace(/\x1b\[[0-9;]*m/g, ''));
  child.stdout.on('data', onOutput); child.stderr.on('data', onOutput);
  child.on('error', error => { appendFileSync(logPath, `\n${error.stack}\n`); controller.close(); process.exitCode = 1; });
  child.on('close', code => {
    appendFileSync(logPath, `\n[supervisor] Proxy exited: ${code}\n`);
    try { if (readState()?.token === token) unlinkSync(statePath); } catch {}
    controller.close();
  });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
async function main() {
  if (![port, targetPort].every(value => Number.isInteger(value) && value >= 1024 && value <= 65535)) throw new Error('Invalid local port.');
  mkdirSync(directory, { recursive: true });
  if (command === 'install') {
    if (existsSync(jar)) { verifyJar(); console.log('Pinned ViaProxy 3.4.13 already installed and verified.'); return; }
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('Downloaded SHA-256 mismatch. No jar installed.');
    writeFileSync(`${jar}.part`, data); renameSync(`${jar}.part`, jar);
    console.log(JSON.stringify({ version: '3.4.13', url, sha256, jar }, null, 2)); return;
  }
  if (command === '--daemon') return daemon();
  if (command === 'start') {
    try { console.log(JSON.stringify(await control('status'), null, 2)); return; } catch {}
    verifyJar(); await available();
    const fd = openSync(resolve(directory, 'supervisor.log'), 'a');
    const processHandle = spawn(process.execPath, [script, '--daemon'], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    processHandle.unref(); closeSync(fd);
    for (let i = 0; i < 60; i++) { await sleep(500); try { const result = await control('status'); if (result.ready) { console.log(JSON.stringify(result, null, 2)); return; } } catch {} }
    throw new Error(`Proxy did not become ready. See ${logPath} and supervisor.log.`);
  }
  if (command === 'status' || command === 'stop') { console.log(JSON.stringify(await control(command), null, 2)); return; }
  throw new Error('Usage: node scripts/local-proxy.mjs install|start|status|stop');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
