import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadState,
  needsReview,
  prKey,
  reviewerKey,
  saveState,
} from '../lib/state.mjs';

const reviewer = { hostname: 'github.com', username: 'OctoCat' };

test('review state keys are scoped to the GitHub reviewer', () => {
  assert.equal(reviewerKey(reviewer), 'github.com@octocat');
  assert.equal(
    prKey('owner/repo', 42, reviewer),
    'github.com@octocat::owner/repo#42',
  );
});

test('review state remains independent for two accounts reviewing one PR', () => {
  const state = {
    [prKey('owner/repo', 42, reviewer)]: {
      lastReviewedSha: 'abc123',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
  };
  assert.equal(needsReview(state, prKey('owner/repo', 42, reviewer), 'abc123'), false);
  assert.equal(
    needsReview(
      state,
      prKey('owner/repo', 42, {
        hostname: 'github.com',
        username: 'another-reviewer',
      }),
      'abc123',
    ),
    true,
  );
});

test('loading malformed state roots fails closed', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');

  for (const malformed of ['[]', 'null', '"state"', '42']) {
    await writeFile(stateFile, `${malformed}\n`);
    await assert.rejects(loadState(stateFile), /Invalid review state.*expected a JSON object/);
  }
});

test('loading malformed review entries fails closed', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  await writeFile(
    stateFile,
    JSON.stringify({
      'owner/repo#1': { lastReviewedSha: 'sha-1' },
    }),
  );

  await assert.rejects(
    loadState(stateFile),
    /Invalid review state entry.*expected lastReviewedSha and lastReviewedAt strings/,
  );
});

test('saving malformed state is rejected before writing', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');

  await assert.rejects(saveState(stateFile, []), /Invalid review state.*expected a JSON object/);
  await assert.rejects(saveState(stateFile, { 'owner/repo#1': null }), /Invalid review state entry/);
  await assert.rejects(stat(stateFile), { code: 'ENOENT' });
});

test('state saves atomically without leaving temporary files', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'nested', 'state.json');
  const state = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
    },
  };

  await saveState(stateFile, state);
  assert.deepEqual(await loadState(stateFile), state);
  if (process.platform !== 'win32') {
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  }
  const replacement = {
    ...state,
    [prKey('owner/repo', 2, reviewer)]: {
      lastReviewedSha: 'sha-2',
      lastReviewedAt: '2026-07-28T01:00:00.000Z',
    },
  };
  await saveState(stateFile, replacement);
  assert.deepEqual(await loadState(stateFile), replacement);
  assert.deepEqual(await readdir(path.dirname(stateFile)), ['state.json']);
});

test('saving an absolute state path does not tighten its existing parent', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-shared-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);

  const stateFile = path.join(root, 'state.json');
  await saveState(stateFile, {});

  assert.equal((await stat(root)).mode & 0o777, 0o755);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
});
