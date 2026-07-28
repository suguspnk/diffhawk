import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import {
  createReviewMarker,
  postReview,
  reviewAlreadyPosted,
  searchReviewRequestedPRs,
} from '../lib/github.mjs';
import { normalizeReviewObject } from '../lib/reviewer-adapter.mjs';

test('any normalized review fits the posting body when all findings are unanchored', async () => {
  const normalized = normalizeReviewObject({
    summary: 's'.repeat(16_000),
    findings: Array.from({ length: 50 }, (_, index) => ({
      path: `dir/${String(index).padStart(2, '0')}-${'p'.repeat(500)}`,
      line: index + 1,
      severity: 'major',
      comment: 'c'.repeat(4_000),
    })),
  });
  let postedBody;

  await postReview({
    repo: 'owner/repo',
    number: 7,
    commitId: 'abc123',
    body: normalized.summary,
    comments: normalized.findings,
    diff: '',
    marker: '<!-- openmergelens:test -->',
    request: async (_args, { input }) => {
      postedBody = JSON.parse(input).body;
    },
  });

  assert.ok(postedBody.length <= 60_000);
});

test('explicit repository search preserves concatenated paginated gh output', async (t) => {
  let command;
  let args;
  t.mock.method(childProcess, 'spawn', (spawnCommand, spawnArgs) => {
    command = spawnCommand;
    args = spawnArgs;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write() {},
      end() {},
    };
    process.nextTick(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          'https://api.github.com/repos/acme/first|7\n' +
          'https://api.github.com/repos/acme/second|8\n',
        ),
      );
      child.emit('close', 0);
    });
    return child;
  });

  const results = await searchReviewRequestedPRs({
    username: 'sera240910',
    repo: 'acme/first',
  });
  assert.deepEqual(results, [
    { repo: 'acme/first', number: 7 },
    { repo: 'acme/second', number: 8 },
  ]);

  assert.equal(command, 'gh');
  assert.ok(args.includes('--paginate'));
  assert.ok(args.includes('--jq'));
  assert.ok(args.some((arg) => arg.includes('.repository_url')));
});

test('gh subprocess output is bounded before parsing', async (t) => {
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => {};
    child.stdin.end = () => {};
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.alloc(32 * 1024 * 1024 + 1));
      child.emit('close', null);
    });
    return child;
  });

  await assert.rejects(
    searchReviewRequestedPRs({
      username: 'octocat',
      repo: 'owner/repo',
    }),
    /stdout exceeded/,
  );
});

const account = {
  hostname: 'github.com',
  username: 'octocat',
};

function reviewOptions(overrides = {}) {
  return {
    repo: 'owner/repo',
    number: 7,
    commitId: 'sha-1',
    body: 'Review summary',
    comments: [{
      path: 'file.js',
      line: 1,
      severity: 'major',
      comment: 'Fix this',
    }],
    diff: '+++ b/file.js\n@@ -0,0 +1 @@\n+line\n',
    marker: createReviewMarker({
      account,
      repo: 'owner/repo',
      number: 7,
      commitId: 'sha-1',
    }),
    auth: { ...account, token: 'test-token' },
    ...overrides,
  };
}

test('review markers are stable across GitHub identifier casing and scoped to a commit', () => {
  const lower = createReviewMarker({
    account,
    repo: 'owner/repo',
    number: 7,
    commitId: 'sha-1',
  });
  const differentlyCased = createReviewMarker({
    account: { hostname: 'GITHUB.COM', username: 'OctoCat' },
    repo: 'OWNER/REPO',
    number: 7,
    commitId: 'sha-1',
  });
  const nextCommit = createReviewMarker({
    account,
    repo: 'owner/repo',
    number: 7,
    commitId: 'sha-2',
  });

  assert.equal(lower, differentlyCased);
  assert.notEqual(lower, nextCommit);
  assert.match(lower, /^<!-- openmergelens-review:[a-f0-9]{64} -->$/);
});

test('reviewAlreadyPosted matches both marker and commit across paginated JSON lines', async () => {
  const options = reviewOptions();
  const request = async () => [
    JSON.stringify({
      body: options.marker,
      commit_id: options.commitId,
      state: 'PENDING',
      user_login: options.auth.username,
    }),
    JSON.stringify({
      body: options.marker,
      commit_id: 'older-sha',
      state: 'COMMENTED',
      user_login: options.auth.username,
    }),
    JSON.stringify({
      body: `summary\n${options.marker}`,
      commit_id: options.commitId,
      state: 'COMMENTED',
      user_login: options.auth.username,
    }),
  ].join('\n');

  assert.equal(await reviewAlreadyPosted({ ...options, request }), true);
});

test('reviewAlreadyPosted rejects a forged marker from a different reviewer', async () => {
  const options = reviewOptions();
  const request = async () => JSON.stringify({
    body: options.marker,
    commit_id: options.commitId,
    state: 'COMMENTED',
    user_login: 'attacker',
  });

  assert.equal(await reviewAlreadyPosted({ ...options, request }), false);
});

test('postReview does not retry a non-validation failure', async () => {
  const calls = [];
  const request = async (args) => {
    const method = args[args.indexOf('--method') + 1];
    calls.push(method);
    if (method === 'POST') throw new Error('connection reset');
    return '';
  };

  await assert.rejects(
    postReview({ ...reviewOptions(), request }),
    /connection reset/,
  );
  assert.deepEqual(calls, ['POST', 'GET']);
});

test('postReview treats an ambiguously successful request as complete after reconciliation', async () => {
  const options = reviewOptions();
  const calls = [];
  let submitted;
  const request = async (args, requestOptions) => {
    const method = args[args.indexOf('--method') + 1];
    calls.push(method);
    if (method === 'POST') {
      submitted = JSON.parse(requestOptions.input);
      throw new Error('connection reset after response');
    }
    return JSON.stringify({
      body: submitted.body,
      commit_id: options.commitId,
      state: 'COMMENTED',
      user_login: options.auth.username,
    });
  };

  await postReview({ ...options, request });
  assert.deepEqual(calls, ['POST', 'GET']);
  assert.match(submitted.body, new RegExp(options.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('postReview retries without inline comments only for an unreconciled 422', async () => {
  const calls = [];
  const payloads = [];
  const request = async (args, requestOptions) => {
    const method = args[args.indexOf('--method') + 1];
    calls.push(method);
    if (method === 'GET') return '';
    payloads.push(JSON.parse(requestOptions.input));
    if (payloads.length === 1) {
      throw Object.assign(new Error('HTTP 422: Validation Failed'), { status: 422 });
    }
    return '{}';
  };

  await postReview({ ...reviewOptions(), request });

  assert.deepEqual(calls, ['POST', 'GET', 'POST']);
  assert.equal(payloads[0].comments.length, 1);
  assert.deepEqual(payloads[1].comments, []);
  assert.match(payloads[1].body, /All findings/);
});

test('postReview rejects unsafe finding fields at the posting boundary', async () => {
  await assert.rejects(
    postReview({
      ...reviewOptions(),
      comments: [{
        path: 'file.js',
        line: 1,
        severity: 'urgent',
        comment: 'unsafe',
      }],
    }),
    /invalid or unsafe finding/,
  );
});

test('postReview does not retry a 422 when no inline comment can be demoted', async () => {
  const calls = [];
  const request = async (args) => {
    const method = args[args.indexOf('--method') + 1];
    calls.push(method);
    if (method === 'GET') return '';
    throw Object.assign(new Error('HTTP 422: Validation Failed'), { status: 422 });
  };

  await assert.rejects(
    postReview({
      ...reviewOptions(),
      comments: [],
      request,
    }),
    /HTTP 422/,
  );
  assert.deepEqual(calls, ['POST', 'GET']);
});
