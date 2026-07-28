export const LEGACY_CODEX_REVIEWER_COMMAND = 'codex exec';

export const CODEX_REVIEWER_COMMAND =
  'codex exec --skip-git-repo-check --ephemeral --sandbox read-only';

export const CODEX_REVIEWER_CHECK_ARGS = [
  'exec',
  '--skip-git-repo-check',
  '--ephemeral',
  '--sandbox',
  'read-only',
  'ok',
];

export function upgradeReviewerCommand(command) {
  const normalized = command.trim();
  return normalized === LEGACY_CODEX_REVIEWER_COMMAND
    ? CODEX_REVIEWER_COMMAND
    : normalized;
}
