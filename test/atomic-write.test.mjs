import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { atomicWriteFile } from '../scripts/atomic-write.mjs';

async function fixture(t) {
  const base = resolve(tmpdir());
  const directory = await mkdtemp(resolve(base, 'kairos-atomic-write-'));
  t.after(async () => {
    const rel = relative(base, directory);
    assert.ok(rel.startsWith('kairos-atomic-write-') && !rel.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  const destination = resolve(directory, 'snapshot.json');
  await writeFile(destination, '{"generation":1}');
  return { directory, destination };
}
const locked = () => Object.assign(new Error('sharing violation'), { code: 'EPERM' });

test('transient replacement failure keeps the old complete checkpoint readable until publication', async t => {
  const { directory, destination } = await fixture(t);
  let calls = 0;
  const retries = [];
  await atomicWriteFile(destination, '{"generation":2}', {
    renameFile: async (source, target) => {
      if (++calls <= 3) { assert.deepEqual(JSON.parse(await readFile(target)), { generation: 1 }); throw locked(); }
      await rename(source, target);
    },
    wait: async () => {}, onRetry: value => retries.push(value),
  });
  assert.equal(calls, 4); assert.equal(retries.length, 3);
  assert.deepEqual(JSON.parse(await readFile(destination)), { generation: 2 });
  assert.deepEqual(await readdir(directory), ['snapshot.json']);
});

test('persistent sharing failure is bounded and preserves old and unpublished snapshots', async t => {
  const { destination } = await fixture(t);
  let calls = 0, failure;
  try {
    await atomicWriteFile(destination, '{"generation":2}', { attempts: 3,
      renameFile: async () => { calls++; throw locked(); }, wait: async () => {} });
  } catch (error) { failure = error; }
  assert.equal(calls, 3); assert.equal(failure?.code, 'EPERM');
  assert.deepEqual(JSON.parse(await readFile(destination)), { generation: 1 });
  assert.deepEqual(JSON.parse(await readFile(failure.pendingFile)), { generation: 2 });
});

test('unrelated filesystem errors are surfaced immediately instead of being swallowed', async t => {
  const { destination } = await fixture(t);
  let calls = 0;
  await assert.rejects(atomicWriteFile(destination, '{}', {
    renameFile: async () => { calls++; throw Object.assign(new Error('disk IO'), { code: 'EIO' }); },
    wait: async () => assert.fail('must not retry EIO'),
  }), error => error.code === 'EIO');
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(await readFile(destination)), { generation: 1 });
});

test('actual Windows reader denying delete-sharing can release its lock and publication recovers',
  { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const { directory, destination } = await fixture(t);
    const script = resolve(directory, 'hold-reader.ps1');
    await writeFile(script, `param([string]$SnapshotPath)\n$reader = [System.IO.File]::Open($SnapshotPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)\ntry { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $reader.Dispose() }\n`);
    const child = spawn(process.env.PWSH ?? (existsSync('C:/Program Files/PowerShell/7/pwsh.exe') ? 'pwsh' : 'powershell'),
      ['-NoProfile', '-NonInteractive', '-File', script, destination], { windowsHide: true }); // pwsh 缺失时回退到系统 powershell（本机环境）
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const exited = once(child, 'exit');
    await new Promise((resolve, reject) => {
      let output = '';
      child.once('error', reject);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('locked')) resolve(); });
      child.once('exit', code => reject(new Error(`reader exited before lock: ${code}`)));
    });
    let retries = 0;
    await atomicWriteFile(destination, '{"generation":2}', { onRetry: () => {
      if (++retries === 1) child.stdin.end('release\n');
    } });
    assert.ok(retries >= 1, 'the OS lock must actually block the first replacement');
    assert.deepEqual(JSON.parse(await readFile(destination)), { generation: 2 });
    await exited;
  });
