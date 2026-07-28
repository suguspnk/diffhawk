export const LEGACY_CODEX_REVIEWER_COMMAND = 'codex exec';
export const PREVIOUS_CODEX_REVIEWER_COMMAND =
  'codex exec --skip-git-repo-check --ephemeral --sandbox read-only';
export const PR_LINK_CODEX_REVIEWER_COMMAND =
  'codex exec --skip-git-repo-check --ephemeral ' +
  '--ignore-user-config --ignore-rules ' +
  '-c \'default_permissions="openmergelens-review"\' ' +
  '-c \'permissions.openmergelens-review.extends=":read-only"\' ' +
  '-c \'permissions.openmergelens-review.network.enabled=true\' ' +
  '-c \'permissions.openmergelens-review.network.domains=' +
  '{"github.com"="allow","**.github.com"="allow"}\'';

export const CODEX_REVIEWER_COMMAND =
  'codex exec --skip-git-repo-check --ephemeral ' +
  '--strict-config --ignore-user-config --ignore-rules ' +
  '-c \'default_permissions="openmergelens-review"\' ' +
  '-c \'permissions.openmergelens-review.extends=":read-only"\' ' +
  '-c \'permissions.openmergelens-review.filesystem=' +
  '{":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny",' +
  '":workspace_roots"={"."="read"}}\'';

export const CLAUDE_REVIEWER_COMMAND =
  'claude -p --output-format text --setting-sources "" ' +
  '--strict-mcp-config --permission-mode dontAsk --max-turns 100 ' +
  '--tools ""';

export const CODEX_REVIEWER_CHECK_ARGS = [
  'exec',
  '--skip-git-repo-check',
  '--ephemeral',
  '--strict-config',
  '--ignore-user-config',
  '--ignore-rules',
  '-c',
  'default_permissions="openmergelens-review"',
  '-c',
  'permissions.openmergelens-review.extends=":read-only"',
  '-c',
  'permissions.openmergelens-review.filesystem=' +
    '{":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny",' +
    '":workspace_roots"={"."="read"}}',
  'ok',
];

export function upgradeReviewerCommand(command) {
  const normalized = command.trim();
  return normalized === LEGACY_CODEX_REVIEWER_COMMAND ||
    normalized === PREVIOUS_CODEX_REVIEWER_COMMAND ||
    normalized === PR_LINK_CODEX_REVIEWER_COMMAND
    ? CODEX_REVIEWER_COMMAND
    : normalized;
}

export function reviewerCommandForGitHubHost(command, hostname) {
  return command;
}

export function reviewerCommandForGitHubGateway(command, gateway) {
  if (command.trim() === CODEX_REVIEWER_COMMAND) {
    const serverCommand =
      `mcp_servers.openmergelens.command=${JSON.stringify(process.execPath)}`;
    const serverArgs =
      `mcp_servers.openmergelens.args=[${JSON.stringify(gateway.mcpServerPath)}]`;
    const enabledTools =
      'mcp_servers.openmergelens.enabled_tools=["inspect_github_pr"]';
    return `${command} -c '${serverCommand}' -c '${serverArgs}' ` +
      `-c '${enabledTools}'`;
  }
  if (command.trim() === CLAUDE_REVIEWER_COMMAND) {
    return `${command} --mcp-config ${JSON.stringify(gateway.mcpConfigPath)} ` +
      '--tools "mcp__openmergelens__inspect_github_pr" ' +
      '--allowedTools "mcp__openmergelens__inspect_github_pr"';
  }
  if (command.includes('{{mcp_config}}') && command.includes('{{mcp_tool}}')) {
    return command
      .replaceAll('{{mcp_config}}', gateway.mcpConfigPath)
      .replaceAll('{{mcp_tool}}', 'mcp__openmergelens__inspect_github_pr');
  }
  throw new Error(
    'custom reviewerCommand cannot inspect linked PRs safely; add both ' +
    '{{mcp_config}} and {{mcp_tool}} placeholders using your reviewer CLI\'s ' +
    'MCP config and allowed-tool flags, or rerun `openmergelens init` to select ' +
    'the generated Codex/Claude command',
  );
}
