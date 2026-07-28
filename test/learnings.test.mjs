import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ensureLearningsFile,
  learningsPathFor,
  readLearnings,
} from '../lib/learnings.mjs';

test('learnings are isolated by host, account, and repository', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'openmergelens-learnings-'));
  const original = process.env.OPENMERGELENS_HOME;
  process.env.OPENMERGELENS_HOME = home;
  t.after(async () => {
    if (original === undefined) delete process.env.OPENMERGELENS_HOME;
    else process.env.OPENMERGELENS_HOME = original;
    await rm(home, { recursive: true, force: true });
  });

  const work = { hostname: 'github.com', username: 'Work-User' };
  const personal = { hostname: 'github.com', username: 'personal' };
  assert.notEqual(
    learningsPathFor(work, 'owner/repo'),
    learningsPathFor(personal, 'owner/repo'),
  );
  assert.notEqual(
    learningsPathFor(work, 'owner/repo'),
    learningsPathFor(work, 'owner/other'),
  );

  const filePath = await ensureLearningsFile(work, 'Owner/Repo');
  assert.equal(await readFile(filePath, 'utf8'), '');
  await writeFile(filePath, 'keep this correction\n');
  await ensureLearningsFile(work, 'owner/repo');
  assert.equal(await readLearnings(work, 'owner/repo'), 'keep this correction\n');
  assert.equal(await readLearnings(personal, 'owner/repo'), '');
});
