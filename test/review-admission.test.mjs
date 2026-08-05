import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewAdmissionGate } from '../lib/review-admission.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('review admission gate never exceeds its limit and preserves queued work', async () => {
  const gate = createReviewAdmissionGate(2);
  const first = await gate.acquire();
  const second = await gate.acquire();
  let thirdGranted = false;
  const thirdPromise = gate.acquire().then((release) => {
    thirdGranted = true;
    return release;
  });

  await tick();
  assert.equal(thirdGranted, false);

  first();
  const third = await thirdPromise;
  assert.equal(thirdGranted, true);
  second();
  third();
  third();
});

test('review admission permits are idempotently releasable', async () => {
  const gate = createReviewAdmissionGate(1);
  const release = await gate.acquire();
  let granted = false;
  const nextPromise = gate.acquire().then((nextRelease) => {
    granted = true;
    return nextRelease;
  });

  release();
  release();
  const nextRelease = await nextPromise;
  assert.equal(granted, true);
  nextRelease();
});

test('review admission rejects invalid limits', () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => createReviewAdmissionGate(value),
      /review admission limit must be a positive safe integer/,
    );
  }
});
