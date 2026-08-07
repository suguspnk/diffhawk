import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const hookPath = path.join(repositoryRoot, '.githooks');

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd });
}

test('post-checkout copies e2e/test.env into a new worktree without overwriting it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openmergelens-worktree-hook-'));
  const worktree = path.join(root, 'worktree');
  const sourceEnv = path.join(root, 'e2e', 'test.env');
  const destinationEnv = path.join(worktree, 'e2e', 'test.env');
  const contents = 'OPENMERGELENS_E2E_REPO=owner/repo\n';

  try {
    await git(root, ['init', '--initial-branch=main']);
    await git(root, ['config', 'user.name', 'OpenMergeLens Tests']);
    await git(root, ['config', 'user.email', 'tests@example.invalid']);
    await mkdir(path.join(root, 'e2e'));
    await writeFile(path.join(root, 'e2e', 'README.md'), '# test\n');
    await git(root, ['add', 'e2e/README.md']);
    await git(root, ['commit', '-m', 'initial commit']);

    await writeFile(sourceEnv, contents, { mode: 0o600 });
    await chmod(sourceEnv, 0o600);
    await git(root, ['config', 'core.hooksPath', hookPath]);

    await git(root, ['worktree', 'add', '-b', 'feature', worktree, 'HEAD']);

    assert.equal(await readFile(destinationEnv, 'utf8'), contents);
    if (process.platform !== 'win32') {
      assert.equal((await stat(destinationEnv)).mode & 0o777, 0o600);
    }

    const replacement = 'OPENMERGELENS_E2E_REPO=local/override\n';
    await writeFile(destinationEnv, replacement);
    await git(worktree, ['checkout', '-b', 'another-feature']);
    assert.equal(await readFile(destinationEnv, 'utf8'), replacement);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
