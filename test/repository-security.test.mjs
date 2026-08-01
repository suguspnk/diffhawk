import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

async function readProjectFile(relativePath) {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

test('only the documented maintainer owns repository changes', async () => {
  const codeowners = await readProjectFile('.github/CODEOWNERS');
  const ownershipRules = codeowners
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  assert.deepEqual(ownershipRules, ['* @suguspnk']);
});

test('repository security baseline requires the critical branch controls', async () => {
  const baseline = await readProjectFile('docs/REPOSITORY_SECURITY.md');

  for (const requirement of [
    'Require review from Code Owners.',
    'Dismiss stale approvals when new commits are pushed.',
    'Require approval of the most recent reviewable push.',
    'Require the `CI gate` status check and require the branch to be current.',
    'Block force pushes and branch deletion.',
  ]) {
    assert.match(baseline, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
