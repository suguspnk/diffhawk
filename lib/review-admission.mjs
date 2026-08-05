import { MAX_CONCURRENT_REVIEW_ADMISSIONS } from './security-limits.mjs';

export function createReviewAdmissionGate(
  limit = MAX_CONCURRENT_REVIEW_ADMISSIONS,
) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('review admission limit must be a positive safe integer');
  }

  let active = 0;
  const waiters = [];

  function createPermit() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const next = waiters.shift();
      if (next) {
        active += 1;
        next(createPermit());
      }
    };
  }

  function acquire() {
    if (active < limit && waiters.length === 0) {
      active += 1;
      return Promise.resolve(createPermit());
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  return { acquire };
}
