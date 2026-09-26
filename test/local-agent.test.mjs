import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const settings = JSON.parse(await readFile(resolve(root, 'local.config.json'), 'utf8'));
const lock = JSON.parse(await readFile(resolve(root, 'upstream.lock.json'), 'utf8'));
const core = resolve(root, settings.coreDirectory);
const { ExperienceSession, ExperienceMedium } = await import(pathToFileURL(resolve(core, lock.entry)).href);

async function fixture(t, changes = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'kairos-local-contract-'));
  t.after(() => {
    const withinTemp = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp));
    return rm(directory, { recursive: true, force: true });
  });
  // Port 1 is intentionally unused: negative validation tests must stop before
  // constructing the body, and must never attach to the real demonstration.
  const config = { ...settings, coreDirectory: core, ...changes,
    minecraft: { ...settings.minecraft, port: 1, ...changes.minecraft } };
  const configPath = resolve(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  return { directory, configPath, config };
}

function cli(configPath, ...args) {
  return spawnSync(process.execPath, [resolve(root, 'local-agent.mjs'), '--config', configPath, ...args], {
    cwd: root, encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
}

function rejected(result, reason) {
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, reason);
}

test('locked native core uses the actual continuing session and V11 medium contracts', () => {
  assert.equal(new ExperienceMedium().snapshot().version, 'KairosExperienceMediumV11');
  assert.equal(lock.mediumVersion, 'KairosExperienceMediumV11');
  const session = new ExperienceSession();
  const state = session.snapshot();
  assert.equal(state.version, lock.sessionVersion);
  assert.deepEqual(ExperienceSession.restore(state).stats, session.stats);
  assert.equal(typeof session.step, 'function');
  assert.equal(typeof session.submit, 'function');
});

test('installation check imports the real core without opening a body or creating a run', async t => {
  const { configPath, directory } = await fixture(t);
  const output = resolve(directory, 'must-not-be-created');
  const result = cli(configPath, '--check', '--output', output);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.status, 'ready');
  assert.equal(report.commit, lock.commit);
  assert.equal(report.browserViewer, false);
  assert.equal(report.display, 'native-client');
  assert.deepEqual(await readdir(directory), ['config.json']);
});

test('CLI rejects remote hosts, incompatible Minecraft versions and invalid budgets before opening a body', async t => {
  for (const [changes, reason] of [
    [{ minecraft: { host: '192.0.2.1' } }, /local-Minecraft-1\.21\.4-required/],
    [{ minecraft: { version: '1.20.1' } }, /local-Minecraft-1\.21\.4-required/],
    [{ minecraft: { port: 65536 } }, /invalid-minecraft-configuration/],
    [{ actions: 0 }, /invalid-actions/],
    [{ checkpointEvery: 0 }, /invalid-checkpoint-interval/],
  ]) {
    const { configPath, directory } = await fixture(t, changes);
    rejected(cli(configPath, '--check'), reason);
    assert.deepEqual(await readdir(directory), ['config.json']);
  }
});

test('CLI rejects a different Git core identity even when it has a readable repository', async t => {
  const { configPath, directory, config } = await fixture(t);
  const alternateCore = resolve(directory, 'different-core');
  await mkdir(alternateCore);
  const git = args => execFileSync('git', ['-c', 'core.autocrlf=false', '-C', alternateCore, ...args], { windowsHide: true, encoding: 'utf8' });
  git(['init', '--quiet']);
  await writeFile(resolve(alternateCore, 'placeholder.txt'), 'Unrelated core for lock rejection.\n');
  git(['add', 'placeholder.txt']);
  git(['-c', 'user.name=Kairos contract test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'Contract test fixture']);
  await writeFile(configPath, JSON.stringify({ ...config, coreDirectory: alternateCore }));
  rejected(cli(configPath, '--check'), /upstream-commit-mismatch/);
});

test('built-code verification rejects altered executable bytes independently of the Git source lock', async t => {
  const { directory } = await fixture(t);
  const alteredCore = resolve(directory, 'altered-core');
  await mkdir(resolve(alteredCore, 'dist/src'), { recursive: true });
  await writeFile(resolve(alteredCore, 'dist/src/prototype.js'), 'export class ExperienceSession {}\n');
  const { verifyCoreBuild } = await import('../scripts/core-build-lock.mjs');
  await assert.rejects(() => verifyCoreBuild(alteredCore, lock.commit), /core-build-digest-mismatch/);
  await assert.rejects(() => verifyCoreBuild(core, '0'.repeat(40)), /core-build-commit-mismatch/);
});

test('CLI refuses an existing evidence directory and preserves its contents', async t => {
  const { configPath, directory } = await fixture(t);
  const output = resolve(directory, 'existing-run');
  await mkdir(output);
  await writeFile(resolve(output, 'evidence.txt'), 'Immutable prior evidence.');
  rejected(cli(configPath, '--output', output, '--no-api'), /EEXIST/);
  assert.deepEqual(await readdir(output), ['evidence.txt']);
  assert.equal(await readFile(resolve(output, 'evidence.txt'), 'utf8'), 'Immutable prior evidence.');
});

test('CLI refuses relabelled legacy memory and requires explicit same-world restore input', async t => {
  const { configPath, directory } = await fixture(t);
  const legacy = resolve(directory, 'legacy.json');
  await writeFile(legacy, JSON.stringify({ version: 'DistributedR2APhysicalMediumV2' }));
  rejected(cli(configPath, '--restore', legacy, '--no-api'), /restore-requires-ExperienceSession1/);
  const forged = new ExperienceSession().snapshot();
  forged.medium.version = 'DistributedR2APhysicalMediumV2';
  await writeFile(legacy, JSON.stringify(forged));
  rejected(cli(configPath, '--restore', legacy, '--no-api'), /experience-medium-version-mismatch/);
  rejected(cli(configPath, '--same-world', '--no-api'), /same-world-requires-restore/);
  assert.deepEqual((await readdir(directory)).sort(), ['config.json', 'legacy.json']);
});
