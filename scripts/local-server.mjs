import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, copyFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
const directory = resolve(process.env.MC_LOCAL_SERVER_DIR || resolve(root, '.local-minecraft/server'));
const statePath = resolve(directory, 'supervisor.json');
const logPath = resolve(directory, 'console.log');
const lockPath = resolve(directory, 'supervisor.lock');
const java = process.env.MC_JAVA21 || 'D:/Kairos-Minecraft/runtime/jdk-21/bin/java.exe';
const jar = process.env.MC_SERVER_JAR || 'D:/Kairos-Minecraft/server/1.21.4/server.jar';
const port = Number(process.env.MC_LOCAL_SERVER_PORT || 25567);
const command = process.argv[2] || 'status';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readState() {
  try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return null; }
}

async function control(action, payload = {}) {
  const state = readState();
  if (!state) throw new Error('No managed local server. Run: node scripts/local-server.mjs start');
  const response = await fetch(`http://127.0.0.1:${state.controlPort}/${action}`, {
    method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(2000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Control request failed: ${response.status}`);
  return result;
}

async function portAvailable() {
  await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(port, '127.0.0.1', () => socket.close(resolve));
  });
}

function prepare() {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid MC_LOCAL_SERVER_PORT');
  if (!existsSync(java)) throw new Error(`Java 21 missing: ${java}. Set MC_JAVA21.`);
  if (!existsSync(jar)) throw new Error(`Minecraft 1.21.4 server jar missing: ${jar}. Set MC_SERVER_JAR.`);
  if (createHash('sha256').update(readFileSync(jar)).digest('hex') !== '1066970b09e9c671844572291c4a871cc1ac2b85838bf7004fa0e778e10f1358') {
    throw new Error('The server jar does not match the verified vanilla Minecraft 1.21.4 artifact. It was not run.');
  }
  mkdirSync(directory, { recursive: true });
  const eula = resolve(directory, 'eula.txt');
  if (!existsSync(eula)) {
    const existingAcceptance = resolve(dirname(jar), 'eula.txt');
    if (!existsSync(existingAcceptance) || !/^eula=true\s*$/m.test(readFileSync(existingAcceptance, 'utf8'))) {
      throw new Error('The source server has no existing EULA acceptance. Read the Minecraft EULA and set eula=true in the local server directory after accepting it.');
    }
    copyFileSync(existingAcceptance, eula);
  }
  const propertiesPath = resolve(directory, 'server.properties');
  if (!existsSync(propertiesPath)) {
    writeFileSync(propertiesPath, [
      '# Persistent local Kairos observation world; never resets on startup.',
      'server-ip=127.0.0.1', `server-port=${port}`, 'motd=Kairos Local - Minecraft 1.21.4',
      'level-name=world', 'level-type=minecraft\\:normal', 'level-seed=20260923',
      'gamemode=survival', 'difficulty=peaceful', 'max-players=8',
      'online-mode=false', 'enforce-secure-profile=false', 'white-list=false',
      'enable-rcon=false', 'enable-query=false', 'enable-command-block=false',
      'allow-flight=true', 'spawn-protection=0', 'view-distance=6', 'simulation-distance=6',
      'max-tick-time=60000', 'sync-chunk-writes=true', 'pause-when-empty-seconds=-1',
      '',
    ].join('\n'), { flag: 'wx' });
  }
  const properties = readFileSync(propertiesPath, 'utf8');
  if (!/^server-ip=127\.0\.0\.1\s*$/m.test(properties) || !new RegExp(`^server-port=${port}\\s*$`, 'm').test(properties)) {
    throw new Error('Existing server.properties must bind 127.0.0.1 and match MC_LOCAL_SERVER_PORT. It was not overwritten.');
  }
}

async function runDaemon() {
  prepare();
  await portAvailable();
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    let alive = true;
    try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('A local server supervisor is already starting or running. Check status.');
    unlinkSync(lockPath);
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  process.on('exit', () => {
    try { if (JSON.parse(readFileSync(lockPath, 'utf8')).pid === process.pid) unlinkSync(lockPath); } catch {}
  });
  const token = randomBytes(32).toString('hex');
  let ready = false;
  let stopping = false;
  let child;
  const writeConsole = command => {
    if (!child || child.exitCode !== null || !child.stdin.writable) throw new Error('Minecraft server is not running');
    child.stdin.write(`${command}\n`);
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (child?.stdin.writable) child.stdin.write('stop\n');
  };
  const controller = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    const reply = (code, object) => { response.writeHead(code); response.end(JSON.stringify(object)); };
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) return reply(403, { error: 'Forbidden' });
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024) return reply(413, { error: 'Request too large' });
      }
      const payload = JSON.parse(body || '{}');
      if (request.url === '/status') return reply(200, {
        service: 'kairos-local-server', ready, stopping, version: '1.21.4',
        address: `127.0.0.1:${port}`, pid: child.pid, supervisorPid: process.pid,
        directory, logPath,
      });
      if (request.url === '/stop') { stop(); return reply(200, { stopping: true, savesWorld: true }); }
      if (request.url === '/observe') {
        const { viewer, bot = 'KairosLocalBot' } = payload;
        if (!/^[A-Za-z0-9_]{3,16}$/.test(viewer || '') || !/^[A-Za-z0-9_]{3,16}$/.test(bot)) throw new Error('Use valid Minecraft player names.');
        if (viewer === bot) throw new Error('The learner cannot be used as the spectator.');
        if (!ready || stopping) throw new Error('Wait for the Minecraft server to finish starting.');
        // These commands affect only the observer. Learner receives no OP, teleport, inventory or world edits.
        writeConsole(`gamemode spectator ${viewer}`);
        writeConsole(`tp ${viewer} ${bot}`);
        writeConsole(`spectate ${bot} ${viewer}`);
        return reply(200, { queued: true, viewer, bot, note: 'Both players must be online. Check console.log for server confirmation; press Shift to leave the camera.' });
      }
      reply(404, { error: 'Unknown action' });
    } catch (error) { reply(400, { error: error.message }); }
  });
  await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
  controller.requestTimeout = 5000;
  controller.headersTimeout = 5000;
  child = spawn(java, ['-Xms512M', '-Xmx1536M', '-jar', jar, 'nogui'], { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  writeFileSync(statePath, JSON.stringify({ token, controlPort: controller.address().port, supervisorPid: process.pid, serverPid: child.pid, startedAt: new Date().toISOString() }, null, 2));
  let pending = '';
  const onOutput = chunk => {
    const message = chunk.toString();
    appendFileSync(logPath, message);
    pending = (pending + message).slice(-3000);
    if (pending.includes('Done (')) ready = true;
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  child.on('error', error => { appendFileSync(logPath, `\n${error.stack}\n`); process.exitCode = 1; controller.close(); });
  child.on('close', code => {
    appendFileSync(logPath, `\n[supervisor] Server exited: ${code}\n`);
    try { if (readState()?.token === token) unlinkSync(statePath); } catch {}
    controller.close();
    process.exitCode = code || 0;
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main() {
  if (command === '--daemon') return runDaemon();
  if (command === 'start') {
    try { console.log(JSON.stringify(await control('status'), null, 2)); return; } catch {}
    prepare();
    await portAvailable();
    const out = openSync(resolve(directory, 'supervisor.log'), 'a');
    const daemon = spawn(process.execPath, [script, '--daemon'], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
    daemon.unref(); closeSync(out);
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      try {
        const status = await control('status');
        if (status.ready) { console.log(JSON.stringify(status, null, 2)); return; }
      } catch {}
    }
    try {
      const status = await control('status');
      console.log(JSON.stringify({ ...status, note: 'Still generating/loading the world. Check status again before starting the agent.' }, null, 2));
      return;
    } catch {}
    throw new Error(`Server supervisor is unavailable. Inspect ${logPath} and supervisor.log.`);
  }
  if (command === 'status') return console.log(JSON.stringify(await control('status'), null, 2));
  if (command === 'stop') {
    console.log(JSON.stringify(await control('stop'), null, 2));
    for (let i = 0; i < 60; i++) { await sleep(500); try { await control('status'); } catch { return; } }
    throw new Error('Server is still saving after 30 seconds. It was not forcibly terminated. Inspect console.log.');
  }
  if (command === 'observe') return console.log(JSON.stringify(await control('observe', { viewer: process.argv[3], bot: process.argv[4] || 'KairosLocalBot' }), null, 2));
  throw new Error('Usage: node scripts/local-server.mjs start|status|stop|observe <viewer> [bot]');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
