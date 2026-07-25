import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REVIEW_BATCH_SIZE,
  processInBatches,
  resolveReviewBatchSize,
} from '../lib/poll-batching.mjs';

test('review batch size defaults to five when omitted', () => {
  assert.equal(resolveReviewBatchSize(undefined), DEFAULT_REVIEW_BATCH_SIZE);
  assert.equal(DEFAULT_REVIEW_BATCH_SIZE, 5);
});

test('review batch size accepts positive whole numbers', () => {
  assert.equal(resolveReviewBatchSize(1), 1);
  assert.equal(resolveReviewBatchSize(12), 12);
});

test('review batch size rejects malformed config values', () => {
  for (const value of [null, 0, -1, 1.5, '5']) {
    assert.throws(
      () => resolveReviewBatchSize(value),
      /reviewBatchSize must be a positive whole number/,
    );
  }
});

test('items run concurrently within a batch and the next batch waits', async () => {
  const items = [1, 2, 3, 4, 5];
  const started = [];
  const releases = new Map();

  const run = processInBatches(items, 2, async (item) => {
    started.push(item);
    await new Promise((resolve) => releases.set(item, resolve));
    return item * 10;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2]);

  releases.get(1)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2]);

  releases.get(2)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 3, 4]);

  releases.get(3)();
  releases.get(4)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 3, 4, 5]);

  releases.get(5)();
  assert.deepEqual(await run, [10, 20, 30, 40, 50]);
});

test('batch processing rejects an invalid size instead of stalling', async () => {
  await assert.rejects(
    processInBatches([1], 0, async (item) => item),
    /reviewBatchSize must be a positive whole number/,
  );
});
