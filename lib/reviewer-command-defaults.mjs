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

export function validateReviewerCommandContract(command) {
  const normalized = upgradeReviewerCommand(command);
  if (
    normalized === CODEX_REVIEWER_COMMAND ||
    normalized === CLAUDE_REVIEWER_COMMAND ||
    (normalized.includes('{{mcp_config}}') && normalized.includes('{{mcp_tool}}'))
  ) {
    return normalized;
  }
  throw new Error(
    'config.json custom reviewerCommand cannot inspect linked PRs safely; use ' +
    'the generated Codex/Claude command or add both {{mcp_config}} and {{mcp_tool}} ' +
    'placeholders using your reviewer CLI\'s MCP config and allowed-tool flags',
  );
}

export function reviewerCommandForGitHubHost(command, hostname) {
  return command;
}

function portableCommandArgument(value, label) {
  if (typeof value !== 'string' || !value || /[\0\r\n"]/u.test(value)) {
    throw new Error(
      `${label} cannot be represented safely in reviewerCommand`,
    );
  }
  return `"${value}"`;
}

function replaceCommandPlaceholder(command, placeholder, value, label) {
  const barePlaceholder = `{{${placeholder}}}`;
  const normalized = command
    .replaceAll(`"${barePlaceholder}"`, barePlaceholder)
    .replaceAll(`'${barePlaceholder}'`, barePlaceholder);
  return normalized.replaceAll(
    barePlaceholder,
    portableCommandArgument(value, label),
  );
}

export function reviewerCommandForGitHubGateway(command, gateway) {
  const normalized = validateReviewerCommandContract(command);
  if (normalized === CODEX_REVIEWER_COMMAND) {
    const serverCommand =
      `mcp_servers.openmergelens.command=${JSON.stringify(process.execPath)}`;
    const serverArgs =
      `mcp_servers.openmergelens.args=[${JSON.stringify(gateway.mcpServerPath)}]`;
    const enabledTools =
      'mcp_servers.openmergelens.enabled_tools=["inspect_github_pr"]';
    const toolApproval =
      'mcp_servers.openmergelens.tools.inspect_github_pr.approval_mode="approve"';
    return `${normalized} -c '${serverCommand}' -c '${serverArgs}' ` +
      `-c '${enabledTools}' -c '${toolApproval}'`;
  }
  if (normalized === CLAUDE_REVIEWER_COMMAND) {
    return `${normalized} --mcp-config ${
      portableCommandArgument(gateway.mcpConfigPath, 'MCP config path')
    } ` +
      '--tools "mcp__openmergelens__inspect_github_pr" ' +
      '--allowedTools "mcp__openmergelens__inspect_github_pr"';
  }
  const withConfig = replaceCommandPlaceholder(
    normalized,
    'mcp_config',
    gateway.mcpConfigPath,
    'MCP config path',
  );
  return replaceCommandPlaceholder(
    withConfig,
    'mcp_tool',
    'mcp__openmergelens__inspect_github_pr',
    'MCP tool name',
  );
}
