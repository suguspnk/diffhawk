const DEFAULT_MIN_INTERVAL_MS = 1_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;
// Node clamps delays above this value to 1ms, which would turn a long
// rate-limit pause into an almost immediate retry. Treat it as the deliberate
// maximum backoff for externally supplied retry/reset values.
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

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

function boundedDelay(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs < 0) return null;
  return Math.min(delayMs, MAX_TIMER_DELAY_MS);
}

function safeTimerDelay(delayMs) {
  if (delayMs <= 0) return 0;
  if (!Number.isFinite(delayMs)) return MAX_TIMER_DELAY_MS;
  return Math.min(delayMs, MAX_TIMER_DELAY_MS);
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('GitHub mutation was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function sleepWithSignal(sleep, delay, signal) {
  throwIfAborted(signal);
  if (delay <= 0 || !signal) return sleep(delay);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const settle = (settler, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      settler(value);
    };
    const onAbort = () => settle(reject, abortReason(signal));

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve(sleep(delay)).then(
      () => settle(resolve),
      (error) => settle(reject, error),
    );
  });
}

function settleWithSignal(result, signal) {
  if (!signal) return result;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const settle = (settler, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      settler(value);
    };
    const onAbort = () => settle(reject, abortReason(signal));

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    result.then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
  });
}

export function githubRateLimitResumeAt(error, nowMs) {
  if (!isGitHubRateLimitError(error)) return null;
  const retryAfterMs = boundedDelay(error.retryAfterMs);
  if (retryAfterMs !== null) {
    return nowMs + retryAfterMs;
  }
  const resetDelayMs = boundedDelay(error.rateLimitResetAtMs - nowMs);
  if (resetDelayMs !== null && resetDelayMs > 0) {
    return nowMs + resetDelayMs;
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
  let lastCompletedAt = Number.NEGATIVE_INFINITY;
  let blockedUntil = 0;

  function run(operation, { signal } = {}) {
    const result = tail.then(async () => {
      throwIfAborted(signal);
      const waitUntil = Math.max(
        blockedUntil,
        Number.isFinite(lastCompletedAt)
          ? lastCompletedAt + minIntervalMs
          : 0,
      );
      const delay = safeTimerDelay(waitUntil - now());
      if (delay > 0) await sleepWithSignal(sleep, delay, signal);
      throwIfAborted(signal);

      try {
        return await operation();
      } catch (error) {
        const resumeAt = githubRateLimitResumeAt(error, now());
        if (resumeAt !== null) blockedUntil = Math.max(blockedUntil, resumeAt);
        throw error;
      } finally {
        lastCompletedAt = now();
      }
    });
    tail = result.catch(() => {});
    return settleWithSignal(result, signal);
  }

  return { run };
}

// Review POST attempts need a process-wide cadence, but must not share the
// per-account queue's rate-limit backoff. A caller can provide a preStart hook
// for final validation; cadence records its start after that hook completes.
export function createGitHubMutationCadence({
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
} = {}) {
  let tail = Promise.resolve();
  let lastStartedAt = Number.NEGATIVE_INFINITY;

  function run(operation, { signal, beforeStart } = {}) {
    const result = tail.then(async () => {
      throwIfAborted(signal);
      const delay = safeTimerDelay(
        lastStartedAt + minIntervalMs - now(),
      );
      if (delay > 0) await sleepWithSignal(sleep, delay, signal);
      throwIfAborted(signal);
      if (beforeStart) await beforeStart();
      throwIfAborted(signal);
      lastStartedAt = now();
      return operation();
    });
    tail = result.catch(() => {});
    return settleWithSignal(result, signal);
  }

  return { run };
}
