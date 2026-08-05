import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGitHubMutationCadence,
  createGitHubMutationQueue,
  githubRateLimitResumeAt,
  isGitHubRateLimitError,
  MAX_TIMER_DELAY_MS,
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

test('queued operations wait after the prior operation completes', async () => {
  let clock = 0;
  const sleeps = [];
  const events = [];
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
    queue.run(async () => {
      starts.push(clock);
      events.push(`GET@${clock}`);
      clock += 900;
      events.push(`POST@${clock}`);
    }),
    queue.run(async () => {
      starts.push(clock);
      events.push(`GET@${clock}`);
    }),
  ]);

  assert.deepEqual(events, ['GET@0', 'POST@900', 'GET@1900']);
  assert.equal(starts[1], 1_900);
  assert.ok(starts[1] >= 1_900);
  assert.deepEqual(sleeps, [1_000]);
});

test('review mutation cadence spaces starts without sharing rate-limit backoff', async () => {
  let clock = 0;
  const sleeps = [];
  const starts = [];
  const cadence = createGitHubMutationCadence({
    minIntervalMs: 1_000,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });

  await assert.rejects(
    cadence.run(async () => {
      starts.push(clock);
      throw Object.assign(new Error('Too Many Requests'), {
        status: 429,
        retryAfterMs: 5_000,
      });
    }),
    /Too Many Requests/,
  );
  await cadence.run(async () => starts.push(clock));

  assert.deepEqual(starts, [0, 1_000]);
  assert.deepEqual(sleeps, [1_000]);
});

test('review cadence runs pre-start validation after waiting and before recording start', async () => {
  let clock = 0;
  const events = [];
  const cadence = createGitHubMutationCadence({
    minIntervalMs: 1_000,
    now: () => clock,
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
      clock += milliseconds;
    },
  });

  await cadence.run(
    async () => events.push(`post:${clock}`),
    {
      beforeStart: async () => {
        events.push(`boundary:${clock}`);
        clock += 100;
      },
    },
  );
  await cadence.run(
    async () => events.push(`post:${clock}`),
    {
      beforeStart: async () => {
        events.push(`boundary:${clock}`);
        clock += 100;
      },
    },
  );

  assert.deepEqual(events, [
    'boundary:0',
    'post:100',
    'sleep:1000',
    'boundary:1100',
    'post:1200',
  ]);
});

test('aborted queued operations stop waiting and never start', async () => {
  let releaseSleep;
  let started = false;
  const queue = createGitHubMutationQueue({
    minIntervalMs: 1_000,
    now: () => 1_000,
    sleep: () => new Promise((resolve) => { releaseSleep = resolve; }),
  });
  await queue.run(async () => {});
  const controller = new AbortController();
  const pending = queue.run(() => {
    started = true;
  }, { signal: controller.signal });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseSleep, 'function');
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(started, false);

  releaseSleep();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, false);
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

test('oversized rate-limit waits are capped at the timer-safe maximum', async () => {
  let clock = 20_000;
  const sleeps = [];
  const queue = createGitHubMutationQueue({
    minIntervalMs: 0,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });

  await assert.rejects(
    queue.run(async () => {
      throw Object.assign(new Error('Too Many Requests'), {
        status: 429,
        retryAfterMs: 3_000_000_000,
      });
    }),
    /Too Many Requests/,
  );
  let resumedAt;
  await queue.run(async () => {
    resumedAt = clock;
  });

  assert.deepEqual(sleeps, [MAX_TIMER_DELAY_MS]);
  assert.ok(sleeps.every((delay) => delay <= MAX_TIMER_DELAY_MS));
  assert.equal(resumedAt, 20_000 + MAX_TIMER_DELAY_MS);
});

test('oversized rate-limit reset waits are capped at the timer-safe maximum', async () => {
  let clock = 20_000;
  const sleeps = [];
  const queue = createGitHubMutationQueue({
    minIntervalMs: 0,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });

  await assert.rejects(
    queue.run(async () => {
      throw Object.assign(new Error('Too Many Requests'), {
        status: 429,
        rateLimitResetAtMs: 20_000 + 3_000_000_000,
      });
    }),
    /Too Many Requests/,
  );
  await queue.run(async () => {});

  assert.deepEqual(sleeps, [MAX_TIMER_DELAY_MS]);
  assert.ok(sleeps.every((delay) => delay <= MAX_TIMER_DELAY_MS));
});

test('default queue sleep never receives an unsafe timer delay', async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    delays.push(delay);
    return realSetTimeout(callback, 0, ...args);
  });
  const queue = createGitHubMutationQueue({ minIntervalMs: 0 });

  await assert.rejects(
    queue.run(async () => {
      throw Object.assign(new Error('Too Many Requests'), {
        status: 429,
        retryAfterMs: 3_000_000_000,
      });
    }),
  );
  await queue.run(async () => {});

  assert.ok(delays.length > 0);
  assert.ok(delays.every((delay) => delay <= MAX_TIMER_DELAY_MS));
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

test('ordinary forbidden errors preserve normal queue spacing without backoff', async () => {
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

  await assert.rejects(
    queue.run(async () => {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }),
    /Forbidden/,
  );
  let nextStartedAt;
  await queue.run(async () => {
    nextStartedAt = clock;
  });

  assert.equal(nextStartedAt, 21_000);
  assert.deepEqual(sleeps, [1_000]);
});
