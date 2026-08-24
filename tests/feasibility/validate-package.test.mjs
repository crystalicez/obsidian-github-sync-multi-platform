import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const validator = resolve('scripts/validate-package.mjs');

async function makeWorkspace({ ignoredSecret = false, trackedSecret = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'v4-validate-package-'));
  await writeFile(join(dir, 'main.js'), 'console.log("ok")\n');
  await writeFile(join(dir, 'styles.css'), 'body{}\n');
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id: 'test-plugin', version: '1.0.7', minAppVersion: '1.0.0' }));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '1.0.7', packageManager: 'pnpm@10.17.1' }));
  await writeFile(join(dir, 'versions.json'), JSON.stringify({ '1.0.7': '1.0.0' }));
  await writeFile(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

  const git = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr || git.stdout);
  const addLock = spawnSync('git', ['add', '--', 'pnpm-lock.yaml'], { cwd: dir, encoding: 'utf8' });
  assert.equal(addLock.status, 0, addLock.stderr || addLock.stdout);

  if (ignoredSecret) {
    await writeFile(join(dir, '.gitignore'), '.env.github-e2e\n');
    await writeFile(join(dir, '.env.github-e2e'), 'TOKEN=local-only\n');
  }

  if (trackedSecret) {
    await writeFile(join(dir, '.env.github-e2e'), 'TOKEN=must-not-ship\n');
    const add = spawnSync('git', ['add', '--', '.env.github-e2e'], { cwd: dir, encoding: 'utf8' });
    assert.equal(add.status, 0, add.stderr || add.stdout);
  }

  return dir;
}

test('package validation allows a local secret file when Git proves it is ignored', async () => {
  const cwd = await makeWorkspace({ ignoredSecret: true });
  const result = spawnSync(process.execPath, [validator], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('package validation rejects a tracked local secret file', async () => {
  const cwd = await makeWorkspace({ trackedSecret: true });
  const result = spawnSync(process.execPath, [validator], { cwd, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /tracked local secret/i);
});
