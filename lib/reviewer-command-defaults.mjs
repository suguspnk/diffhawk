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
  'login',
  'status',
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

export function reviewerBackendForCommand(command) {
  if (typeof command !== 'string') return null;
  const normalized = upgradeReviewerCommand(command);
  if (normalized === CODEX_REVIEWER_COMMAND) return 'codex';
  if (normalized === CLAUDE_REVIEWER_COMMAND) return 'claude';
  return null;
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

function jsonForSingleQuotedConfig(value) {
  if (typeof value !== 'string') {
    throw new Error('MCP server path must be a string');
  }

  // The JSON value is embedded inside a single-quoted reviewerCommand. The
  // portable command parser treats backslashes before whitespace/quotes as
  // command-line escapes, so JSON's usual `\\` and `\"` escapes would be
  // consumed before Codex can parse the TOML/JSON value. Encode those syntax
  // characters as Unicode escapes instead; ordinary path text remains as-is.
  let encoded = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) {
      encoded += '\\u0022';
    } else if (code === 0x27) {
      encoded += '\\u0027';
    } else if (code === 0x5c) {
      encoded += '\\u005c';
    } else if (code === 0x08) {
      encoded += '\\b';
    } else if (code === 0x09) {
      encoded += '\\t';
    } else if (code === 0x0a) {
      encoded += '\\n';
    } else if (code === 0x0c) {
      encoded += '\\f';
    } else if (code === 0x0d) {
      encoded += '\\r';
    } else if (code < 0x20) {
      encoded += `\\u${code.toString(16).padStart(4, '0')}`;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode = value.charCodeAt(index + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        // Valid UTF-16 pairs are valid TOML/JSON text and need no escaping.
        encoded += value[index] + value[index + 1];
        index += 1;
      } else {
        // Keep lone surrogates representable as JSON text without emitting
        // invalid Unicode into the command string.
        encoded += `\\u${code.toString(16).padStart(4, '0')}`;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      encoded += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      encoded += value[index];
    }
  }
  return `${encoded}"`;
}

function appendKnownModelArguments(command, model, backend) {
  if (model === undefined || model === null) return command;
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw new Error('reviewer model settings must be a normalized object or null');
  }

  const args = [];
  if (model.id) {
    args.push('--model', portableCommandArgument(model.id, 'model ID'));
  }
  if (model.reasoningEffort) {
    if (!/^(?:none|low|medium|high|xhigh|max)$/u.test(model.reasoningEffort)) {
      throw new Error('reviewer reasoning effort is not a supported safe value');
    }
    if (backend === 'codex') {
      // Codex exposes reasoning effort through its TOML config override.
      args.push(
        '-c',
        `'model_reasoning_effort="${model.reasoningEffort}"'`,
      );
    } else if (backend === 'claude') {
      args.push('--effort', portableCommandArgument(model.reasoningEffort, 'reasoning effort'));
    }
  }
  return args.length ? `${command} ${args.join(' ')}` : command;
}

export function reviewerCommandForModel(command, model) {
  if (model === undefined || model === null) return command;
  const normalized = validateReviewerCommandContract(command);
  const backend = reviewerBackendForCommand(normalized);
  if (!backend) {
    throw new Error(
      'model settings require the generated Codex or Claude reviewer command',
    );
  }
  return appendKnownModelArguments(normalized, model, backend);
}

export function reviewerCommandForGitHubGateway(command, gateway, model) {
  const normalized = validateReviewerCommandContract(command);
  if (normalized === CODEX_REVIEWER_COMMAND) {
    const serverCommand =
      `mcp_servers.openmergelens.command=${jsonForSingleQuotedConfig(process.execPath)}`;
    const serverArgs =
      `mcp_servers.openmergelens.args=[${jsonForSingleQuotedConfig(gateway.mcpServerPath)}]`;
    const enabledTools =
      'mcp_servers.openmergelens.enabled_tools=["inspect_github_pr"]';
    const toolApproval =
      'mcp_servers.openmergelens.tools.inspect_github_pr.approval_mode="approve"';
    const gatewayCommand = `${normalized} -c '${serverCommand}' -c '${serverArgs}' ` +
      `-c '${enabledTools}' -c '${toolApproval}'`;
    return appendKnownModelArguments(gatewayCommand, model, 'codex');
  }
  if (normalized === CLAUDE_REVIEWER_COMMAND) {
    const gatewayCommand = `${normalized} --mcp-config ${
      portableCommandArgument(gateway.mcpConfigPath, 'MCP config path')
    } ` +
      '--tools "mcp__openmergelens__inspect_github_pr" ' +
      '--allowedTools "mcp__openmergelens__inspect_github_pr"';
    return appendKnownModelArguments(gatewayCommand, model, 'claude');
  }
  if (model !== undefined && model !== null) {
    throw new Error(
      'model settings require the generated Codex or Claude reviewer command',
    );
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
