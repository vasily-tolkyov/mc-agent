import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify, parseArgs } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createControlServer, validateGroundedGoal } from './local-control.mjs';
import { verifyCoreBuild } from './scripts/core-build-lock.mjs';
import { acquireAgentOwnership } from './scripts/agent-ownership.mjs';
import { atomicWriteFile } from './scripts/atomic-write.mjs';
import { wrapEgocentric } from './egocentric-wrap.mjs';
import { wrapConcept } from './concept-wrap.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const compress = promisify(gzip), decompress = promisify(gunzip);
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const positive = (value, label, integer = true) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isSafeInteger(n))) throw new Error(`invalid-${label}`);
  return n;
};
const saveOptions = { onRetry: retry => console.error(JSON.stringify({ kind: 'checkpoint-replace-retry', ...retry })) };
const atomicJson = (file, value) => atomicWriteFile(file, JSON.stringify(value, null, 2), saveOptions);

export async function runLocalAgent(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    help: { type: 'boolean' }, config: { type: 'string' }, output: { type: 'string' },
    actions: { type: 'string' }, seconds: { type: 'string' }, restore: { type: 'string' },
    'same-world': { type: 'boolean' }, goal: { type: 'string' }, 'no-api': { type: 'boolean' },
    'check': { type: 'boolean' },
  } });
  if (values.help) {
    console.log('node local-agent.mjs [--actions 1024] [--seconds 3600] [--output NEW_DIRECTORY]\n'
      + '  [--restore SESSION.json.gz] [--same-world] [--goal GOAL.json] [--no-api] [--check]\n'
      + 'Display: Minecraft Java 1.21.4 at 127.0.0.1:25567; 26.3 through local ViaProxy at :25568.');
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later required');
  const configPath = resolve(values.config ?? resolve(ROOT, 'local.config.json'));
  const config = await json(configPath), lock = await json(resolve(ROOT, 'upstream.lock.json'));
  const core = resolve(dirname(configPath), config.coreDirectory);
  const commit = execFileSync('git', ['-C', core, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  if (commit !== lock.commit) throw new Error('upstream-commit-mismatch: rebuild and review upstream.lock.json before changing core');
  if (execFileSync('git', ['-C', core, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', windowsHide: true }).trim())
    throw new Error('upstream-tracked-files-modified: use a separately reviewed core lock');
  if (config.minecraft.host !== '127.0.0.1' || config.minecraft.version !== '1.21.4') throw new Error('local-Minecraft-1.21.4-required');
  positive(config.minecraft.port, 'minecraft-port');
  positive(config.controlPort, 'control-port');
  if (config.controlPort > 65535) throw new Error('invalid-control-port');
  if (config.minecraft.port > 65535 || !/^[A-Za-z0-9_]{1,16}$/.test(config.minecraft.username)
    || typeof config.minecraft.worldId !== 'string' || !config.minecraft.worldId) throw new Error('invalid-minecraft-configuration');
  const budget = positive(values.actions ?? config.actions, 'actions');
  const seconds = positive(values.seconds ?? config.seconds, 'seconds', false);
  const checkpointEvery = positive(config.checkpointEvery, 'checkpoint-interval');
  const entry = resolve(core, lock.entry);
  await stat(entry).catch(() => { throw new Error('core-not-built: run npm run build:core'); });
  await verifyCoreBuild(core, commit);
  const [{ ExperienceSession, ExperienceMedium }, { MinecraftBodyConnection }, { MinecraftExperienceEnvironment }, { EvidenceJournal }] =
    await Promise.all([
      import(pathToFileURL(entry).href),
      import(pathToFileURL(resolve(core, 'scripts/minecraft-body-connection.mjs')).href),
      import(pathToFileURL(resolve(core, 'dist/src/adapters/minecraft/experience.js')).href),
      import(pathToFileURL(resolve(core, 'scripts/evidence-journal.mjs')).href),
    ]);
  if (new ExperienceMedium().snapshot().version !== lock.mediumVersion) throw new Error('built-core-contract-mismatch');
  if (values.check) { console.log(JSON.stringify({ status: 'ready', core, commit, minecraft: config.minecraft, display: 'native-client', browserViewer: false })); return; }
  if (values['same-world'] && !values.restore) throw new Error('same-world-requires-restore');
  let session = new ExperienceSession(), restoreSha256 = null;
  if (values.restore) {
    const source = resolve(values.restore), bytes = await readFile(source);
    restoreSha256 = createHash('sha256').update(bytes).digest('hex');
    const snapshot = JSON.parse((bytes[0] === 31 && bytes[1] === 139 ? await decompress(bytes) : bytes).toString());
    if (values['same-world']) {
      const manifest = await json(resolve(dirname(source), 'manifest.json'));
      if (JSON.stringify(manifest.minecraft) !== JSON.stringify(config.minecraft)) throw new Error('same-world-configuration-mismatch');
    }
    if (snapshot.version !== lock.sessionVersion) throw new Error('restore-requires-ExperienceSession1: legacy box/lattice memory cannot be relabelled');
    session = ExperienceSession.restore(snapshot, { sameWorld: !!values['same-world'] });
  }
  if (values.goal) {
    const input = await json(resolve(values.goal));
    for (const goal of Array.isArray(input) ? input : [input]) session.submit(validateGroundedGoal(goal));
  }
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const output = resolve(values.output ?? resolve(ROOT, 'runs', id));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Never overwrite an earlier run.
  await mkdir(resolve(output, 'events'));
  await mkdir(resolve(output, 'passive-events'));
  await atomicJson(resolve(output, 'manifest.json'), { version: 'MinecraftLocalRun1', startedAt: new Date().toISOString(),
    upstream: lock, minecraft: config.minecraft, display: 'native-client', browserViewer: false,
    sensor: 'upstream RGBD and proprioception', restore: values.restore ? resolve(values.restore) : null,
    restoreSha256, sameWorld: !!values['same-world'], actions: budget, seconds });
  const journal = new EvidenceJournal(output);
  let auditTail = Promise.resolve(), auditPending = 0, evidenceFailure = null;
  const recordBody = (kind, value) => {
    if (evidenceFailure) return;
    if (++auditPending > 2048) { evidenceFailure = new Error('body-audit-backpressure-limit'); auditPending--; return; }
    auditTail = auditTail.then(() => journal.write('body', { kind, value })).catch(error => { evidenceFailure ??= error; })
      .finally(() => { auditPending--; });
  };
  const releaseOwnership = await acquireAgentOwnership({ directory: resolve(ROOT, 'runtime'), identity: { output, minecraft: config.minecraft } });
  let body;
  try { body = new MinecraftBodyConnection({ ...config.minecraft, sessionId: randomUUID() }, recordBody); }
  catch (error) { await releaseOwnership(); throw error; }
  const base = wrapConcept(wrapEgocentric(new MinecraftExperienceEnvironment(body))); // 适配层：自我中心通道 + 概念自形成（不改核心）
  let eventCount = 0, passiveCount = 0, stopping = false, phase = 'connecting', lastDecision = null, api = null;
  const start = Date.now();
  let status = 'budget-paused', failure;
  const pause = () => { stopping = true; return { status: 'pause-requested', checkpoint: resolve(output, 'session.json.gz') }; };
  process.once('SIGINT', pause); process.once('SIGTERM', pause);
  const archivePassive = async events => {
    for (const event of events ?? []) await writeFile(resolve(output, 'passive-events', String(++passiveCount).padStart(7, '0') + '.json.gz'),
      await compress(JSON.stringify(event)), { flag: 'wx' });
    return events ?? [];
  };
  const environment = {
    maintenanceGoals: base.maintenanceGoals,
    drainPassiveEvents: async () => archivePassive(await base.drainPassiveEvents()),
    observe: () => base.observe(), listActionOffers: observation => base.listActionOffers(observation),
    waitForObservationAfter: sequence => base.waitForObservationAfter(sequence),
    executeOffer: async offer => {
      if (stopping || evidenceFailure) throw new Error(stopping ? 'operator-pause-before-action' : 'evidence-write-failed');
      const receipt = await base.executeOffer(offer);
      await archivePassive(receipt.precedingPassiveEvents);
      if (receipt.event) await writeFile(resolve(output, 'events', String(++eventCount).padStart(7, '0') + '.json.gz'),
        await compress(JSON.stringify(receipt.event)), { flag: 'wx' });
      return receipt;
    },
  };
  const save = async () => {
    const file = resolve(output, 'session.json.gz');
    await atomicWriteFile(file, await compress(JSON.stringify(session.snapshot())), saveOptions);
    await mkdir(resolve(ROOT, 'runtime'), { recursive: true });
    await atomicJson(resolve(ROOT, 'runtime/LATEST.json'), { output, session: file, minecraft: config.minecraft,
      updatedAt: new Date().toISOString(), stats: session.stats });
  };
  const getStatus = () => {
    let observation = null;
    try { const frame = body.latest(); observation = { sequence: frame.sequence, self: frame.self }; } catch { /* connecting/fault */ }
    return { phase, pauseRequested: stopping, upstream: commit, minecraft: config.minecraft, output,
      seconds: (Date.now() - start) / 1000, ...session.stats, observation,
      tasks: session.tasks.map(({ goal, status, actions, bestResidual }) => ({ goal, status, actions, bestResidual })),
      lastDecision };
  };
  try {
    if (!values['no-api']) api = await createControlServer({ port: config.controlPort, getStatus, pause,
      submit: goal => { if (stopping) throw new Error('session-pausing'); session.submit(goal); return { accepted: true, goalId: goal.id }; } });
    await body.ready(); phase = 'running'; await save();
    console.log(JSON.stringify({ status: 'LOCAL_MINECRAFT_READY', minecraft: config.minecraft,
      api: api ? `http://127.0.0.1:${config.controlPort}` : null, output, display: 'native-client' }));
    for (let index = 0; index < budget; index++) {
      if (evidenceFailure) throw evidenceFailure;
      if (stopping || existsSync(resolve(output, 'PAUSE'))) { status = 'operator-paused'; break; }
      if ((Date.now() - start) / 1000 >= seconds) { status = 'duration-paused'; break; }
      const decision = await session.step(environment);
      await journal.write('decisions', decision);
      lastDecision = { index: decision.index, status: decision.status, source: decision.source,
        goalId: decision.goalId, action: decision.offer?.action.kind, planReason: decision.planReason,
        planLength: decision.planLength, learned: decision.learned, exploration: decision.exploration };
      console.log(JSON.stringify({ ...lastDecision, ...session.stats }));
      if ((index + 1) % checkpointEvery === 0 || decision.status === 'goal-verified') await save();
      if (decision.status === 'observation-stalled' || decision.status === 'no-offers') { status = decision.status; break; }
    }
  } catch (error) {
    status = stopping && error.message === 'operator-pause-before-action' ? 'operator-paused' : 'fault-paused';
    if (status === 'fault-paused') { failure = String(error.stack ?? error); process.exitCode = 1; }
  } finally {
    if (stopping && status === 'budget-paused') status = 'operator-paused';
    stopping = true; phase = 'saving';
    // Preserve completed passive windows after the final decision for audit. They
    // are not passed through another decision/learning step during shutdown.
    try {
      const tail = await base.drainPassiveEvents();
      await archivePassive(tail);
      if (tail.length) await journal.write('unconsumed-passive', { count: tail.length, reason: 'shutdown-after-last-decision' });
    } catch (error) { failure ??= String(error.stack ?? error); }
    // A disconnected body can reject close(). Saving learned state must still run.
    try { await body.close(); } catch (error) { failure ??= String(error.stack ?? error); }
    await auditTail;
    for (const flush of [save, () => journal.export(), () => { if (evidenceFailure) throw evidenceFailure; }]) {
      try { await flush(); }
      catch (error) { status = 'evidence-incomplete'; failure = String(error.stack ?? error); process.exitCode = 1; }
    }
    phase = status;
    try {
      await atomicJson(resolve(output, 'result.json'), { status, failure, seconds: (Date.now() - start) / 1000,
        ...session.stats, tasks: session.tasks, eventCount, passiveCount, output });
      console.log(JSON.stringify({ status, failure, ...session.stats, output }));
    } finally {
      if (api) await new Promise(resolve => { api.close(resolve); api.closeAllConnections(); });
      process.removeListener('SIGINT', pause); process.removeListener('SIGTERM', pause);
      await releaseOwnership();
    }
  }
  return { status, output };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  runLocalAgent().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
