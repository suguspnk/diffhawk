export const DEFAULT_REVIEW_BATCH_SIZE = 5;

export function resolveReviewBatchSize(configuredSize) {
  if (configuredSize === undefined) return DEFAULT_REVIEW_BATCH_SIZE;

  if (!Number.isInteger(configuredSize) || configuredSize < 1) {
    throw new Error('config.json reviewBatchSize must be a positive whole number');
  }

  return configuredSize;
}

export async function processInBatches(items, batchSize, worker) {
  const resolvedBatchSize = resolveReviewBatchSize(batchSize);
  const results = [];

  for (let offset = 0; offset < items.length; offset += resolvedBatchSize) {
    const batch = items.slice(offset, offset + resolvedBatchSize);
    results.push(...await Promise.all(batch.map(worker)));
  }

  return results;
}
