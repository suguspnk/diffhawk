import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pollOnce } from '../lib/poller.mjs';
import { saveState } from '../lib/state.mjs';

const work = {
  hostname: 'github.com',
  username: 'work',
  repositories: ['owner/repo'],
};
const personal = {
  hostname: 'github.com',
  username: 'personal',
  repositories: ['owner/repo'],
};

function config(accounts = [work, personal]) {
  return {
    configVersion: 2,
    githubAccounts: accounts,
    reviewerCommand: 'reviewer',
    reviewerInputMode: 'stdin',
    reviewBatchSize: 2,
    reviewFocusCount: 1,
    stateFile: './state.json',
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'openrevuwer-poller-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    stateFile: path.join(root, 'state.json'),
    logPath: path.join(root, 'poll.log'),
    defaultReviewPromptPath: path.join(root, 'template.md'),
  };
}

function successfulDependencies(events) {
  return {
    resolveGitHubAuth: async (account) => ({ ...account, token: `${account.username}-token` }),
    currentUsername: async ({ auth }) => auth.username,
    searchReviewRequestedPRs: async ({ username, repo }) => {
      events.push(`search:${username}:${repo}`);
      return [{ repo, number: 7 }];
    },
    getPullRequest: async () => ({
      headRefOid: 'sha-1',
      number: 7,
      title: 'PR',
      body: '',
    }),
    getPullRequestDiff: async () => '@@ -0,0 +1 @@\n+line\n',
    reviewAlreadyPosted: async () => false,
    ensureReviewPrompt: async () => '/virtual/prompt.md',
    readPrompt: async () => '{{diff}}',
    readLearnings: async (account) => `learning:${account.username}`,
    invokeMultiPassReview: async ({ learnings }) => {
      events.push(`review:${learnings}`);
      return { summary: 'reviewed', findings: [] };
    },
    postReview: async ({ auth }) => {
      events.push(`post:${auth.username}`);
    },
  };
}

test('two requested accounts independently review and persist the same PR', async (t) => {
  const files = await fixture(t);
  const events = [];
  const result = await pollOnce({
    config: config(),
    ...files,
    dependencies: successfulDependencies(events),
  });

  assert.deepEqual(result, { failed: false, reviewed: 2 });
  assert.deepEqual(events.filter((event) => event.startsWith('post:')).sort(), [
    'post:personal',
    'post:work',
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith('review:')).sort(), [
    'review:learning:personal',
    'review:learning:work',
  ]);

  const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.deepEqual(Object.keys(state).sort(), [
    'github.com@personal::owner/repo#7',
    'github.com@work::owner/repo#7',
  ]);
});

test('one unavailable account does not block healthy account work and marks failure', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  dependencies.resolveGitHubAuth = async (account) => {
    if (account.username === 'work') throw new Error('credential expired');
    return { ...account, token: 'safe-token' };
  };

  const result = await pollOnce({
    config: config(),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(events.includes('post:personal'), true);
  assert.equal(events.includes('post:work'), false);
  assert.match(await readFile(files.logPath, 'utf8'), /\[work@github\.com\].*account unavailable/);
});

test('a PR failure leaves its state untouched while another account completes', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  dependencies.invokeMultiPassReview = async ({ learnings }) => {
    if (learnings.includes('work')) throw new Error('review failed');
    return { summary: 'reviewed', findings: [] };
  };

  const result = await pollOnce({
    config: config(),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.deepEqual(Object.keys(state), ['github.com@personal::owner/repo#7']);
});

test('account-filtered dry runs invoke only that reviewer and never write state', async (t) => {
  const files = await fixture(t);
  const events = [];
  const result = await pollOnce({
    config: config(),
    ...files,
    dryRun: true,
    accountSelector: { hostname: 'github.com', username: 'personal' },
    dependencies: successfulDependencies(events),
  });

  assert.deepEqual(result, { failed: false, reviewed: 1 });
  assert.deepEqual(events.filter((event) => event.startsWith('search:')), [
    'search:personal:owner/repo',
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });
});

test('a posted review is reconciled after state persistence fails without reposting', async (t) => {
  const files = await fixture(t);
  const events = [];
  const postedMarkers = new Set();
  let failNextSave = true;
  const dependencies = successfulDependencies(events);
  dependencies.postReview = async ({ marker }) => {
    events.push('post');
    postedMarkers.add(marker);
  };
  dependencies.reviewAlreadyPosted = async ({ marker }) => postedMarkers.has(marker);
  dependencies.saveState = async (...args) => {
    if (failNextSave) {
      failNextSave = false;
      throw new Error('disk unavailable');
    }
    return saveState(...args);
  };

  const first = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });
  assert.equal(first.failed, true);
  assert.deepEqual(events.filter((event) => event === 'post'), ['post']);
  await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });

  const second = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });
  assert.deepEqual(second, { failed: false, reviewed: 1 });
  assert.deepEqual(events.filter((event) => event === 'post'), ['post']);
  assert.equal(events.filter((event) => event.startsWith('review:')).length, 1);

  const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.equal(
    state['github.com@work::owner/repo#7'].lastReviewedSha,
    'sha-1',
  );
});
