/**
 * Disposable fixture for review-rendering QA. Do not merge.
 */
export function canDeleteAccount(session) {
  return Boolean(session?.authenticated);
}
