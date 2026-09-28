import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const VERSION = 'MinecraftAgentOwnership1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function failure(code, detail) {
  const error = new Error(`${code}${detail ? ': ' + detail : ''}`);
  error.code = code;
  return error;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw failure('agent-owner-liveness-unknown', String(error.message));
  }
}

async function readOwner(file) {
  try {
    const owner = JSON.parse(await readFile(file, 'utf8'));
    if (owner?.version !== VERSION || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || !UUID.test(owner.runId) || !Object.hasOwn(owner, 'identity')) throw new Error('invalid ownership record');
    return owner;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // An initializing writer may briefly expose incomplete JSON. Refusing that
    // record is safer than treating an unreadable PID as a dead owner.
    throw failure('agent-owner-unreadable', `${file}: ${error.message}`);
  }
}

async function removeMine(file, owner) {
  const current = await readOwner(file);
  if (current?.runId === owner.runId && current.pid === owner.pid) await unlink(file);
}

/** Claim one local bot execution slot. Every caller using the same directory
 * competes for the same slot, independently of its proposed identity. PID
 * reuse and inaccessible processes are deliberately considered live. */
export async function acquireAgentOwnership({ directory, identity }) {
  if (typeof directory !== 'string' || !directory.trim() || identity === undefined)
    throw failure('invalid-agent-ownership');
  const root = resolve(directory), file = resolve(root, 'agent-owner.json');
  // Validate serialization before creating any ownership file.
  const owner = { version: VERSION, runId: randomUUID(), pid: process.pid,
    acquiredAt: new Date().toISOString(), identity };
  const text = JSON.stringify(owner) + '\n';
  if (!Object.hasOwn(JSON.parse(text), 'identity')) throw failure('invalid-agent-ownership-identity');
  await mkdir(root, { recursive: true });

  for (let attempt = 0; attempt < 40; attempt++) {
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (handle) {
      try { await handle.writeFile(text); await handle.sync(); }
      catch (error) {
        await handle.close();
        // An incomplete record is left fail-closed. Never remove an unknown
        // record just because writing our own record failed.
        throw error;
      }
      await handle.close();
      let releasePromise;
      return async () => {
        releasePromise ??= removeMine(file, owner);
        await releasePromise;
      };
    }

    let previous;
    try { previous = await readOwner(file); }
    catch (error) {
      if (error.code === 'agent-owner-unreadable' && attempt < 3) { await delay(25); continue; }
      throw error;
    }
    if (!previous) continue;
    if (alive(previous.pid)) throw failure('agent-owner-active', `pid=${previous.pid}, runId=${previous.runId}`);

    // Serialize reclamation of this exact dead record. Without this marker,
    // two stale readers could unlink the freshly created successor's lock.
    // An interrupted reaper leaves a fail-closed marker; it is never itself
    // assumed disposable without an operator inspecting the interrupted run.
    const marker = resolve(root, `agent-owner-reap-${previous.runId}.json`);
    let reaper;
    try { reaper = await open(marker, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await delay(25); continue;
    }
    try {
      await reaper.writeFile(text); await reaper.close(); reaper = null;
      const current = await readOwner(file);
      if (current?.runId === previous.runId && current.pid === previous.pid && !alive(current.pid)) await unlink(file);
    } finally {
      if (reaper) await reaper.close();
      await removeMine(marker, owner);
    }
  }
  throw failure('agent-owner-recovery-busy', 'ownership changed repeatedly or a prior reclamation was interrupted');
}
