import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function digestTree(directory) {
  const result = [];
  async function visit(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:js|mjs|json)$/.test(entry.name))
        result.push([relative(directory, path).replaceAll('\\', '/'), createHash('sha256').update(await readFile(path)).digest('hex')]);
    }
  }
  await visit(directory);
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}

export async function verifyCoreBuild(core, expectedCommit) {
  const lock = JSON.parse(await readFile(resolve(root, 'core-build.lock.json'), 'utf8'));
  if (lock.commit !== expectedCommit) throw new Error('core-build-commit-mismatch: run npm run build:core');
  const actual = await digestTree(resolve(core, 'dist/src'));
  if (lock.distSourceSha256 !== actual) throw new Error('core-build-digest-mismatch: run npm run build:core');
  return lock;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const config = JSON.parse(await readFile(resolve(root, 'local.config.json'), 'utf8'));
  const core = resolve(root, config.coreDirectory);
  if (process.argv[2] !== '--record') throw new Error('use --record only after a successful core build');
  const upstream = JSON.parse(await readFile(resolve(root, 'upstream.lock.json'), 'utf8'));
  const commit = execFileSync('git', ['-C', core, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  if (commit !== upstream.commit) throw new Error('upstream-commit-mismatch');
  await writeFile(resolve(root, 'core-build.lock.json'), JSON.stringify({ commit: upstream.commit,
    distSourceSha256: await digestTree(resolve(core, 'dist/src')) }, null, 2) + '\n');
  console.log('Recorded built core digest.');
}
