import path from 'node:path';
import { homedir } from 'node:os';

const COMMON_ENVIRONMENT_KEYS = new Set([
  'APPDATA',
  'COMSPEC',
  'ComSpec',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LOCALAPPDATA',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'WINDIR',
  'windir',
]);

const CODEX_AUTH_KEYS = new Set([
  'CODEX_HOME',
]);

const CLAUDE_AUTH_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_ACCESS_KEY_ID',
  'AWS_CONFIG_FILE',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SHARED_CREDENTIALS_FILE',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
]);

const GITHUB_REVIEW_KEYS = new Set([
  'GH_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_PROMPT_DISABLED',
  'GH_TOKEN',
  'OPENMERGELENS_GITHUB_ACCOUNT',
]);

function homePath(environment, homeDirectory = homedir()) {
  return environment.USERPROFILE || homeDirectory || environment.HOME;
}

function pathModuleForHome(home) {
  return /^[A-Za-z]:[\\/]/.test(home) || home.includes('\\')
    ? path.win32
    : path.posix;
}

function defaultConfigPath(environment, key, directoryName, homeDirectory = homedir()) {
  const configured = environment[key];
  if (typeof configured === 'string' && configured.trim()) return configured;

  const home = homePath(environment, homeDirectory);
  if (!home) return undefined;
  return pathModuleForHome(home).join(home, directoryName);
}

function defaultCodexHome(environment, homeDirectory = homedir()) {
  return defaultConfigPath(environment, 'CODEX_HOME', '.codex', homeDirectory);
}

function defaultClaudeConfigDir(environment, homeDirectory = homedir()) {
  return defaultConfigPath(
    environment,
    'CLAUDE_CONFIG_DIR',
    '.claude',
    homeDirectory,
  );
}

export function withCodexDefaultHome(
  environment,
  {
    homeDirectory = homedir(),
  } = {},
) {
  const codexHome = defaultCodexHome(environment, homeDirectory);
  return codexHome ? { ...environment, CODEX_HOME: codexHome } : { ...environment };
}

export function withClaudeDefaultConfigDir(
  environment,
  {
    homeDirectory = homedir(),
  } = {},
) {
  const claudeConfigDir = defaultClaudeConfigDir(environment, homeDirectory);
  return claudeConfigDir
    ? { ...environment, CLAUDE_CONFIG_DIR: claudeConfigDir }
    : { ...environment };
}

export function withoutGitHubCredentials(environment) {
  const sanitized = { ...environment };
  for (const key of GITHUB_REVIEW_KEYS) delete sanitized[key];
  sanitized.GH_PROMPT_DISABLED = '1';
  return sanitized;
}

function commandName(command) {
  return path.basename(command || '').replace(/\.(?:cmd|bat|exe)$/i, '').toLowerCase();
}

export function reviewerBackend(command) {
  const name = commandName(command);
  if (name === 'codex') return 'codex';
  if (name === 'claude') return 'claude';
  return 'custom';
}

export function buildReviewerEnvironment(
  command,
  sourceEnvironment = process.env,
  options = {},
) {
  const backend = reviewerBackend(command);
  const allowed = new Set(COMMON_ENVIRONMENT_KEYS);
  if (backend === 'codex') {
    for (const key of CODEX_AUTH_KEYS) allowed.add(key);
  } else if (backend === 'claude') {
    for (const key of CLAUDE_AUTH_KEYS) allowed.add(key);
  }
  for (const key of GITHUB_REVIEW_KEYS) allowed.add(key);

  const environment = {};
  for (const [key, value] of Object.entries(sourceEnvironment)) {
    if (
      typeof value === 'string' &&
      (allowed.has(key) || key.startsWith('LC_'))
    ) {
      environment[key] = value;
    }
  }

  if (backend === 'claude') {
    environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    environment.CLAUDE_CODE_SAFE_MODE = '1';
    return withClaudeDefaultConfigDir(environment, options);
  } else if (backend === 'codex') {
    return withCodexDefaultHome(environment, options);
  }

  return environment;
}
