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
