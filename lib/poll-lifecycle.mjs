export async function flushLoggerAndReleaseLock({ logger, releaseLock }) {
  try {
    await logger.flush();
  } catch {
    // Logging is best effort and must not replace the poll's operational result.
  }

  if (!releaseLock) return;

  try {
    await releaseLock();
  } catch (error) {
    try {
      await logger.warn(`operation lock release failed: ${error?.message || String(error)}`, {
        event: 'lock.release.failure',
        fields: { scope: 'operation-lock' },
        error,
      });
    } catch {
      // Lock-release observability is best effort and must not reject cleanup.
    }
  }
}
