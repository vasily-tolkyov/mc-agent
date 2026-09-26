import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { acquireAgentOwnership } from '../scripts/agent-ownership.mjs';

const moduleUrl = new URL('../scripts/agent-ownership.mjs', import.meta.url).href;
const childCode = `
import { createInterface } from 'node:readline';
const { acquireAgentOwnership } = await import(process.argv[1]);
try {
  const release = await acquireAgentOwnership({ directory: process.argv[2], identity: { username: 'TestBot' } });
  const input = createInterface({ input: process.stdin });
  let finished = false;
  const done = async () => { if (finished) return; finished = true; clearTimeout(limit); await release(); input.close(); process.stdin.destroy(); };
  const limit = setTimeout(() => { done().catch(error => { console.error(error); process.exitCode = 1; }); }, 10000);
  input.once('line', () => { done().catch(error => { console.error(error); process.exitCode = 1; }); });
  input.once('close', () => { done().catch(error => { console.error(error); process.exitCode = 1; }); });
  console.log(JSON.stringify({ acquired: true, pid: process.pid }));
} catch (error) { console.log(JSON.stringify({ acquired: false, code: error.code })); process.exitCode = 2; }
`;

async function temporary(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'kairos-owner-test-'));
  t.after(async () => {
    const inside = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function actor(directory) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, moduleUrl, directory], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  const exit = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  const first = once(lines, 'line').then(([line]) => JSON.parse(line));
  return { child, first, exit, diagnostics: () => stderr,
    async release() { if (child.exitCode === null) child.stdin.end('release\n'); return exit; } };
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { windowsHide: true });
  let output = '';
  child.stdout.on('data', value => { output += value; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  return Number(output);
}

const record = (pid, runId = randomUUID()) => ({ version: 'MinecraftAgentOwnership1', pid, runId,
  acquiredAt: '2026-01-01T00:00:00Z', identity: { username: 'TestBot' } });

test('two real processes cannot own the same agent directory concurrently', { timeout: 15000 }, async t => {
  const directory = await temporary(t);
  const actors = [actor(directory), actor(directory)];
  try {
    const outcomes = await Promise.all(actors.map(value => value.first));
    assert.equal(outcomes.filter(value => value.acquired).length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.find(value => !value.acquired).code, 'agent-owner-active');
    const owner = JSON.parse(await readFile(resolve(directory, 'agent-owner.json'), 'utf8'));
    assert.equal(owner.pid, outcomes.find(value => value.acquired).pid);
    assert.deepEqual(owner.identity, { username: 'TestBot' });
  } finally {
    const exits = await Promise.all(actors.map(value => value.release()));
    assert.deepEqual(exits.map(([code]) => code).sort(), [0, 2], actors.map(value => value.diagnostics()).join('\n'));
  }
  assert.deepEqual(await readdir(directory), []);
});

test('competing processes safely reclaim one definitively dead PID record', { timeout: 15000 }, async t => {
  const directory = await temporary(t);
  const stale = record(await deadPid());
  await writeFile(resolve(directory, 'agent-owner.json'), JSON.stringify(stale));
  const actors = [actor(directory), actor(directory)];
  try {
    const outcomes = await Promise.all(actors.map(value => value.first));
    assert.equal(outcomes.filter(value => value.acquired).length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.find(value => !value.acquired).code, 'agent-owner-active');
    const current = JSON.parse(await readFile(resolve(directory, 'agent-owner.json'), 'utf8'));
    assert.notEqual(current.runId, stale.runId);
    assert.equal(current.pid, outcomes.find(value => value.acquired).pid);
  } finally { await Promise.all(actors.map(value => value.release())); }
  assert.deepEqual(await readdir(directory), []);
});

test('a live PID and an unreadable record remain untouched', { timeout: 5000 }, async t => {
  const directory = await temporary(t), file = resolve(directory, 'agent-owner.json');
  const active = JSON.stringify(record(process.pid));
  await writeFile(file, active);
  await assert.rejects(acquireAgentOwnership({ directory, identity: 'second' }), { code: 'agent-owner-active' });
  assert.equal(await readFile(file, 'utf8'), active);
  await writeFile(file, '{interrupted');
  await assert.rejects(acquireAgentOwnership({ directory, identity: 'second' }), { code: 'agent-owner-unreadable' });
  assert.equal(await readFile(file, 'utf8'), '{interrupted');
});

test('release is idempotent and never removes another run UUID', async t => {
  const directory = await temporary(t), file = resolve(directory, 'agent-owner.json');
  const release = await acquireAgentOwnership({ directory, identity: 'first' });
  const replacement = JSON.stringify(record(process.pid));
  await writeFile(file, replacement);
  await Promise.all([release(), release()]);
  assert.equal(await readFile(file, 'utf8'), replacement);
});

test('a normal release permits the next run to acquire the slot', async t => {
  const directory = await temporary(t);
  const release = await acquireAgentOwnership({ directory, identity: 'first' });
  const before = JSON.parse(await readFile(resolve(directory, 'agent-owner.json'), 'utf8'));
  await Promise.all([release(), release()]);
  const next = await acquireAgentOwnership({ directory, identity: 'second' });
  const after = JSON.parse(await readFile(resolve(directory, 'agent-owner.json'), 'utf8'));
  assert.notEqual(before.runId, after.runId);
  await next();
  assert.deepEqual(await readdir(directory), []);
});
