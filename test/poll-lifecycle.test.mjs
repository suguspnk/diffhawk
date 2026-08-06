import test from 'node:test';
import assert from 'node:assert/strict';
import { flushLoggerAndReleaseLock } from '../lib/poll-lifecycle.mjs';

test('flushes logger before releasing the operation lock', async () => {
  const events = [];
  let allowFlush;
  const flushGate = new Promise((resolve) => {
    allowFlush = resolve;
  });

  const cleanup = flushLoggerAndReleaseLock({
    logger: {
      async flush() {
        events.push('flush-start');
        await flushGate;
        events.push('flush-end');
      },
    },
    async releaseLock() {
      events.push('release');
    },
  });

  await Promise.resolve();
  assert.deepEqual(events, ['flush-start']);
  allowFlush();
  await cleanup;

  assert.deepEqual(events, ['flush-start', 'flush-end', 'release']);
});

test('releases the operation lock when logger flush fails', async () => {
  let released = false;

  await assert.doesNotReject(() => flushLoggerAndReleaseLock({
    logger: {
      async flush() {
        throw new Error('flush failed');
      },
    },
    async releaseLock() {
      released = true;
    },
  }));

  assert.equal(released, true);
});

test('observes lock-release failures without rejecting cleanup', async () => {
  const events = [];
  const releaseError = new Error('release failed');

  const result = await flushLoggerAndReleaseLock({
    logger: {
      async flush() {
        events.push('flush');
      },
      async warn(message, options) {
        events.push('warn');
        assert.equal(message, 'operation lock release failed: release failed');
        assert.deepEqual(options, {
          event: 'lock.release.failure',
          fields: { scope: 'operation-lock' },
          error: releaseError,
        });
      },
    },
    async releaseLock() {
      events.push('release');
      throw releaseError;
    },
  });

  assert.equal(result, undefined);
  assert.deepEqual(events, ['flush', 'release', 'warn']);
});
