/**
 * Disposable live-review fixture. Do not merge.
 */
export function canDeleteAccount(session) {
  return Boolean(session?.authenticated);
}
