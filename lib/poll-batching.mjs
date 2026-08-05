import { MAX_REVIEW_BATCH_SIZE } from './security-limits.mjs';

export const DEFAULT_REVIEW_BATCH_SIZE = 5;

export function isValidReviewBatchSize(configuredSize) {
  return Number.isInteger(configuredSize) &&
    configuredSize >= 1 &&
    configuredSize <= MAX_REVIEW_BATCH_SIZE;
}

export function resolveReviewBatchSize(configuredSize) {
  if (configuredSize === undefined) return DEFAULT_REVIEW_BATCH_SIZE;

  if (!isValidReviewBatchSize(configuredSize)) {
    throw new Error(
      `config.json reviewBatchSize must be a whole number from 1 to ${MAX_REVIEW_BATCH_SIZE}`,
    );
  }

  return configuredSize;
}

export async function processInBatches(items, batchSize, worker) {
  const resolvedBatchSize = resolveReviewBatchSize(batchSize);
  const results = [];

  for (let offset = 0; offset < items.length; offset += resolvedBatchSize) {
    const batch = items.slice(offset, offset + resolvedBatchSize);
    const settled = await Promise.allSettled(
      batch.map((item) => Promise.resolve().then(() => worker(item))),
    );
    const failed = settled.find((result) => result.status === 'rejected');

    if (failed) throw failed.reason;

    results.push(...settled.map((result) => result.value));
  }

  return results;
}

export async function processWithConcurrency(items, concurrency, worker) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive whole number');
  }

  const results = new Array(items.length);
  let nextIndex = 0;
  let active = 0;
  let hasFailure = false;
  let failure;

  return new Promise((resolve, reject) => {
    const schedule = () => {
      if (hasFailure) {
        if (active === 0) reject(failure);
        return;
      }

      while (active < concurrency && nextIndex < items.length) {
        const index = nextIndex++;
        active += 1;
        Promise.resolve()
          .then(() => worker(items[index]))
          .then(
            (result) => {
              results[index] = result;
              active -= 1;
              schedule();
            },
            (error) => {
              hasFailure = true;
              failure = error;
              active -= 1;
              schedule();
            },
          );
      }

      if (nextIndex === items.length && active === 0) resolve(results);
    };

    schedule();
  });
}
