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
  aiProcessingConsent: ['owner/repo'],
};
const personal = {
  hostname: 'github.com',
  username: 'personal',
  repositories: ['owner/repo'],
  aiProcessingConsent: ['owner/repo'],
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
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-poller-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    stateFile: path.join(root, 'state.json'),
    logPath: path.join(root, 'poll.log'),
    defaultReviewPromptPath: path.join(root, 'template.md'),
  };
}

function successfulDependencies(events) {
  return {
    createGitHubMutationQueue: () => ({
      run: async (operation) => {
        events.push('mutation:scheduled');
        return operation();
      },
    }),
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
      url: 'https://github.com/owner/repo/pull/7',
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
    postReview: async ({ auth, scheduleMutation }) =>
      scheduleMutation(async () => {
        events.push(`post:${auth.username}`);
      }),
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

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 2);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(
    result.outcomes.map(({ status, repo, number }) => ({ status, repo, number })),
    [
      { status: 'reviewed', repo: 'owner/repo', number: 7 },
      { status: 'reviewed', repo: 'owner/repo', number: 7 },
    ],
  );
  assert.deepEqual(events.filter((event) => event.startsWith('post:')).sort(), [
    'post:personal',
    'post:work',
  ]);
  assert.equal(
    events.filter((event) => event === 'mutation:scheduled').length,
    2,
  );
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
  assert.equal(result.failures[0].note, 'authentication failed');
  assert.equal(events.includes('post:personal'), true);
  assert.equal(events.includes('post:work'), false);
  assert.match(await readFile(files.logPath, 'utf8'), /\[work@github\.com\].*account unavailable/);
});

test('a repository without AI-processing consent never reaches search or reviewer execution', async (t) => {
  const files = await fixture(t);
  const events = [];
  const unconsented = {
    ...work,
    aiProcessingConsent: [],
  };

  const result = await pollOnce({
    config: config([unconsented]),
    ...files,
    dependencies: successfulDependencies(events),
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.equal(result.failures[0].note, 'AI-processing consent required');
  assert.deepEqual(events, []);
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

test('the reviewer receives only the selected account credential environment', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  let reviewerEnvironment;
  dependencies.invokeMultiPassReview = async ({ environment }) => {
    reviewerEnvironment = environment;
    return { summary: 'reviewed', findings: [] };
  };

  await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(reviewerEnvironment.GH_TOKEN, 'work-token');
  assert.equal(reviewerEnvironment.GH_HOST, 'github.com');
  assert.equal(reviewerEnvironment.GH_PROMPT_DISABLED, '1');
  assert.equal(
    reviewerEnvironment.OPENMERGELENS_GITHUB_ACCOUNT,
    'work@github.com',
  );
});

test('a diff larger than two MiB still reaches the reviewer and posting anchor flow', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  dependencies.getPullRequestDiff = async () =>
    `@@ -0,0 +1 @@\n+${'x'.repeat(2 * 1024 * 1024)}\n`;
  let reviewed = false;
  let postedDiffBytes = 0;
  dependencies.invokeMultiPassReview = async () => {
    reviewed = true;
    return { summary: 'reviewed', findings: [] };
  };
  dependencies.postReview = async ({ diff }) => {
    postedDiffBytes = Buffer.byteLength(diff, 'utf8');
  };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.equal(reviewed, true);
  assert.ok(postedDiffBytes > 2 * 1024 * 1024);
});

test('new commits arriving during review prevent a stale review from posting', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  let metadataCalls = 0;
  dependencies.getPullRequest = async () => {
    metadataCalls += 1;
    return {
      headRefOid: metadataCalls === 1 ? 'sha-1' : 'sha-2',
      number: 7,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/7',
      body: '',
    };
  };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.equal(result.failures[0].note, 'new commits during review');
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });
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

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.equal(result.outcomes[0].status, 'dry-run');
  assert.deepEqual(result.failures, []);
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
  assert.equal(first.reviewed, 0);
  assert.equal(first.failures[0].status, 'tracking-failed');
  assert.equal(first.failures[0].note, 'will reconcile');
  assert.deepEqual(events.filter((event) => event === 'post'), ['post']);
  await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });

  const second = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });
  assert.equal(second.failed, false);
  assert.equal(second.reviewed, 1);
  assert.equal(second.outcomes[0].status, 'recovered');
  assert.deepEqual(second.failures, []);
  assert.deepEqual(events.filter((event) => event === 'post'), ['post']);
  assert.equal(events.filter((event) => event.startsWith('review:')).length, 1);

  const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.equal(
    state['github.com@work::owner/repo#7'].lastReviewedSha,
    'sha-1',
  );
});

test('new commits are reported as a re-review while an unchanged head is a no-op', async (t) => {
  const files = await fixture(t);
  const key = 'github.com@work::owner/repo#7';
  await saveState(files.stateFile, {
    [key]: {
      lastReviewedSha: 'old-sha',
      lastReviewedAt: '2026-01-01T00:00:00.000Z',
    },
  });

  const firstEvents = [];
  const first = await pollOnce({
    config: config([work]),
    ...files,
    dependencies: successfulDependencies(firstEvents),
  });
  assert.equal(first.outcomes[0].status, 're-reviewed');

  const secondEvents = [];
  const second = await pollOnce({
    config: config([work]),
    ...files,
    dependencies: successfulDependencies(secondEvents),
  });
  assert.deepEqual(second, {
    failed: false,
    reviewed: 0,
    outcomes: [],
    failures: [],
  });
  assert.deepEqual(
    secondEvents.filter((event) => event.startsWith('review:')),
    [],
  );
});
