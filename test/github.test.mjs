import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import {
  createReviewMarker,
  getPullRequest,
  postReview,
  retryMetadataFromDiagnostic,
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
    auth: { hostname: 'github.com', username: 'octocat', token: 'test-token' },
    scheduleMutation: (operation) => operation(),
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
  assert.ok(args.includes('q=is:pr is:open review-requested:sera240910 repo:acme/first'));
  assert.ok(args.some((arg) => arg.includes('.repository_url')));
});

test('pull request metadata includes the current state', async (t) => {
  let args;
  t.mock.method(childProcess, 'spawn', (_spawnCommand, spawnArgs) => {
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
        Buffer.from(JSON.stringify({
          headRefOid: 'sha-1',
          number: 7,
          state: 'OPEN',
        })),
      );
      child.emit('close', 0);
    });
    return child;
  });

  const pullRequest = await getPullRequest({
    repo: 'owner/repo',
    number: 7,
  });

  assert.equal(pullRequest.state, 'OPEN');
  const fields = args[args.indexOf('--json') + 1].split(',');
  assert.ok(fields.includes('state'));
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

test('GitHub response headers expose Retry-After and rate-reset timing', () => {
  assert.deepEqual(
    retryMetadataFromDiagnostic(
      'HTTP/2.0 429 Too Many Requests\r\n' +
      'retry-after: 7\r\n' +
      'x-ratelimit-reset: 2000000000\r\n',
    ),
    {
      retryAfterMs: 7_000,
      rateLimitResetAtMs: 2_000_000_000_000,
    },
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
    scheduleMutation: (operation) => operation(),
    ...overrides,
  };
}

test('postReview requires mutation scheduling at its GitHub write boundary', async () => {
  const { scheduleMutation: _scheduleMutation, ...options } = reviewOptions();
  await assert.rejects(
    postReview(options),
    /requires a GitHub mutation scheduler/,
  );
});

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

test('postReview stops immediately when GitHub rate-limits the mutation', async () => {
  const calls = [];
  const request = async (args) => {
    const method = args[args.indexOf('--method') + 1];
    calls.push(method);
    throw Object.assign(new Error('secondary rate limit'), {
      status: 403,
      retryAfterMs: 60_000,
    });
  };

  await assert.rejects(
    postReview({ ...reviewOptions(), request }),
    /secondary rate limit/,
  );
  assert.deepEqual(calls, ['POST']);
});

test('postReview fallback stops without reconciliation when GitHub rate-limits it', async () => {
  const calls = [];
  let postCount = 0;
  const request = async (args) => {
    const method = args[args.indexOf('--method') + 1];
    calls.push(method);
    if (method === 'GET') return '';
    postCount += 1;
    if (postCount === 1) {
      throw Object.assign(new Error('Validation Failed'), { status: 422 });
    }
    throw Object.assign(new Error('secondary rate limit'), { status: 429 });
  };

  await assert.rejects(
    postReview({ ...reviewOptions(), request }),
    /secondary rate limit/,
  );
  assert.deepEqual(calls, ['POST', 'GET', 'POST']);
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
  assert.match(
    submitted.body,
    /AI-generated review:.*OpenMergeLens.*on behalf of @octocat/,
  );
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
