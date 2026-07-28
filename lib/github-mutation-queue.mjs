const DEFAULT_MIN_INTERVAL_MS = 1_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

function diagnosticFor(error) {
  return [
    error?.message,
    error?.stderr,
    error?.stdout,
  ].filter(Boolean).join('\n');
}

export function isGitHubRateLimitError(error) {
  if (error?.status === 429) return true;
  return error?.status === 403 &&
    /\b(?:rate limit|secondary rate|abuse detection)\b/i.test(
      diagnosticFor(error),
    );
}

export function githubRateLimitResumeAt(error, nowMs) {
  if (!isGitHubRateLimitError(error)) return null;
  if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) {
    return nowMs + error.retryAfterMs;
  }
  if (
    Number.isFinite(error.rateLimitResetAtMs) &&
    error.rateLimitResetAtMs > nowMs
  ) {
    return error.rateLimitResetAtMs;
  }
  return nowMs + DEFAULT_RATE_LIMIT_BACKOFF_MS;
}

export function createGitHubMutationQueue({
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
} = {}) {
  let tail = Promise.resolve();
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let blockedUntil = 0;

  function run(operation) {
    const result = tail.then(async () => {
      const waitUntil = Math.max(
        blockedUntil,
        Number.isFinite(lastStartedAt)
          ? lastStartedAt + minIntervalMs
          : 0,
      );
      const delay = waitUntil - now();
      if (delay > 0) await sleep(delay);

      lastStartedAt = now();
      try {
        return await operation();
      } catch (error) {
        const resumeAt = githubRateLimitResumeAt(error, now());
        if (resumeAt !== null) blockedUntil = Math.max(blockedUntil, resumeAt);
        throw error;
      }
    });
    tail = result.catch(() => {});
    return result;
  }

  return { run };
}
