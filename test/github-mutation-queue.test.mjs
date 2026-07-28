import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGitHubMutationQueue,
  githubRateLimitResumeAt,
  isGitHubRateLimitError,
} from '../lib/github-mutation-queue.mjs';

test('GitHub mutations are serialized with at least one configured interval', async () => {
  let clock = 10_000;
  const sleeps = [];
  const starts = [];
  const queue = createGitHubMutationQueue({
    minIntervalMs: 1_000,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });

  await Promise.all([
    queue.run(async () => starts.push(clock)),
    queue.run(async () => starts.push(clock)),
    queue.run(async () => starts.push(clock)),
  ]);

  assert.deepEqual(starts, [10_000, 11_000, 12_000]);
  assert.deepEqual(sleeps, [1_000, 1_000]);
});

test('rate limits pause queued mutations using Retry-After', async () => {
  let clock = 20_000;
  const sleeps = [];
  const queue = createGitHubMutationQueue({
    minIntervalMs: 1_000,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });
  const rateLimitError = Object.assign(
    new Error('secondary rate limit'),
    { status: 403, retryAfterMs: 5_000 },
  );

  await assert.rejects(
    queue.run(async () => {
      throw rateLimitError;
    }),
    /secondary rate limit/,
  );
  let resumedAt;
  await queue.run(async () => {
    resumedAt = clock;
  });

  assert.equal(resumedAt, 25_000);
  assert.deepEqual(sleeps, [5_000]);
});

test('rate-limit classification does not treat ordinary forbidden responses as throttling', () => {
  assert.equal(
    isGitHubRateLimitError(Object.assign(new Error('Forbidden'), { status: 403 })),
    false,
  );
  assert.equal(
    isGitHubRateLimitError(
      Object.assign(new Error('API rate limit exceeded'), { status: 403 }),
    ),
    true,
  );
  assert.equal(
    githubRateLimitResumeAt(
      Object.assign(new Error('Too Many Requests'), {
        status: 429,
        rateLimitResetAtMs: 30_000,
      }),
      20_000,
    ),
    30_000,
  );
});
