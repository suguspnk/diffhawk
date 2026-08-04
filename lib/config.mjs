import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveReviewBatchSize } from './poll-batching.mjs';
import { resolveReviewFocusCount } from './reviewer-adapter.mjs';
import {
  reviewerBackendForCommand,
  validateReviewerCommandContract,
} from './reviewer-command-defaults.mjs';
import {
  normalizeReviewerModel,
} from './reviewer-models.mjs';
import {
  createAiProcessingConsent,
  normalizeAiProcessingConsent,
} from './ai-processing-consent.mjs';
import {
  enforcePrivateMode,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
} from './file-security.mjs';

export const CONFIG_VERSION = 4;
const PREVIOUS_CONFIG_VERSION = 3;
const LEGACY_CONFIG_VERSION = 2;

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)*(?<!-)$/i;
const ACCOUNT_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,38})$/i;
const REPOSITORY_SEGMENT_PATTERN = /^[a-z0-9._-]+$/i;
const CONFIG_FIELDS = new Set([
  'configVersion',
  'githubAccounts',
  'aiProcessingConsent',
  'reviewerCommand',
  'model',
  'reviewerInputMode',
  'reviewBatchSize',
  'reviewFocusCount',
  'desktopNotifications',
  'stateFile',
]);
const ACCOUNT_FIELDS = new Set([
  'hostname',
  'username',
  'repositories',
]);

function migrateLegacyConfig(input) {
  if (
    input.configVersion !== LEGACY_CONFIG_VERSION &&
    input.configVersion !== PREVIOUS_CONFIG_VERSION
  ) {
    return { input, legacyConsentGranted: false };
  }

  if (input.configVersion === PREVIOUS_CONFIG_VERSION) {
    return {
      input: {
        ...input,
        configVersion: CONFIG_VERSION,
      },
      legacyConsentGranted: false,
    };
  }

  const githubAccounts = Array.isArray(input.githubAccounts)
    ? input.githubAccounts.map((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return candidate;
      }
      const { aiProcessingConsent: _legacyConsent, ...account } = candidate;
      return account;
    })
    : input.githubAccounts;
  let legacyConsentGranted = false;
  if (Array.isArray(input.githubAccounts) && input.githubAccounts.length > 0) {
    legacyConsentGranted = input.githubAccounts.every((account) => {
      if (
        !Array.isArray(account?.repositories) ||
        !Array.isArray(account?.aiProcessingConsent)
      ) {
        return false;
      }
      const consented = new Set(
        account.aiProcessingConsent.map((repository) =>
          normalizeRepository(repository).toLowerCase(),
        ),
      );
      const selected = new Set(
        account.repositories.map((repository) =>
          normalizeRepository(repository).toLowerCase(),
        ),
      );
      return consented.size === account.aiProcessingConsent.length &&
        consented.size === selected.size &&
        [...selected].every((repository) => consented.has(repository));
    });
  }

  return {
    input: {
      ...input,
      configVersion: CONFIG_VERSION,
      githubAccounts,
      aiProcessingConsent: undefined,
    },
    legacyConsentGranted,
  };
}

function rejectUnknownFields(value, allowed, context) {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw new Error(`${context} contains unsupported field "${unknown}"`);
}

export function normalizeGitHubAccount(account) {
  const hostname = account?.hostname?.trim().toLowerCase();
  const username = account?.username?.trim();

  if (!hostname || !HOSTNAME_PATTERN.test(hostname)) {
    throw new Error('GitHub account hostname is invalid');
  }
  if (!username || !ACCOUNT_SEGMENT_PATTERN.test(username)) {
    throw new Error('GitHub account username is invalid');
  }

  return { hostname, username };
}

export function accountKey(account) {
  const { hostname, username } = normalizeGitHubAccount(account);
  return `${hostname}@${username.toLowerCase()}`;
}

export function accountLabel(account) {
  const { hostname, username } = normalizeGitHubAccount(account);
  return `${username}@${hostname}`;
}

export function normalizeRepository(repository) {
  if (typeof repository !== 'string') {
    throw new Error('GitHub repository must be an OWNER/REPO string');
  }

  const trimmed = repository.trim();
  const parts = trimmed.split('/');
  if (
    parts.length !== 2 ||
    !ACCOUNT_SEGMENT_PATTERN.test(parts[0]) ||
    !REPOSITORY_SEGMENT_PATTERN.test(parts[1]) ||
    parts[1].length > 100 ||
    parts[1] === '.' ||
    parts[1] === '..'
  ) {
    throw new Error(`GitHub repository "${repository}" must be a valid OWNER/REPO`);
  }

  return trimmed;
}

export function parseAccountSelector(selector) {
  if (typeof selector !== 'string') {
    throw new Error('account selector must be USERNAME@HOSTNAME');
  }
  const separator = selector.indexOf('@');
  if (separator <= 0 || separator !== selector.lastIndexOf('@')) {
    throw new Error(`account selector "${selector}" must be USERNAME@HOSTNAME`);
  }
  return normalizeGitHubAccount({
    username: selector.slice(0, separator),
    hostname: selector.slice(separator + 1),
  });
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('config.json must contain a JSON object');
  }
  const migration = migrateLegacyConfig(input);
  input = migration.input;
  rejectUnknownFields(input, CONFIG_FIELDS, 'config.json');
  if (input.configVersion !== CONFIG_VERSION) {
    throw new Error(
      `config.json must use configVersion ${CONFIG_VERSION}; run \`openmergelens init\``,
    );
  }
  if (!Array.isArray(input.githubAccounts) || input.githubAccounts.length === 0) {
    throw new Error('config.json githubAccounts must contain at least one account');
  }
  if (typeof input.reviewerCommand !== 'string' || !input.reviewerCommand.trim()) {
    throw new Error('config.json reviewerCommand must be a non-empty string');
  }
  if (
    input.reviewerInputMode !== undefined &&
    input.reviewerInputMode !== 'stdin'
  ) {
    throw new Error('config.json reviewerInputMode must be "stdin"');
  }
  if (
    input.stateFile !== undefined &&
    (typeof input.stateFile !== 'string' || !input.stateFile.trim())
  ) {
    throw new Error('config.json stateFile must be a non-empty string');
  }
  if (
    input.desktopNotifications !== undefined &&
    typeof input.desktopNotifications !== 'boolean'
  ) {
    throw new Error('config.json desktopNotifications must be true or false');
  }
  const seenAccounts = new Set();
  const githubAccounts = input.githubAccounts.map((candidate, accountIndex) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`config.json githubAccounts[${accountIndex}] must be an object`);
    }
    rejectUnknownFields(
      candidate,
      ACCOUNT_FIELDS,
      `config.json githubAccounts[${accountIndex}]`,
    );
    const account = normalizeGitHubAccount(candidate);
    const key = accountKey(account);
    if (seenAccounts.has(key)) {
      throw new Error(`config.json contains duplicate GitHub account ${accountLabel(account)}`);
    }
    seenAccounts.add(key);

    if (!Array.isArray(candidate.repositories) || candidate.repositories.length === 0) {
      throw new Error(
        `config.json githubAccounts[${accountIndex}].repositories must contain at least one repository`,
      );
    }
    const seenRepositories = new Set();
    const repositories = candidate.repositories.map((repository) => {
      const normalized = normalizeRepository(repository);
      const repositoryKey = normalized.toLowerCase();
      if (seenRepositories.has(repositoryKey)) {
        throw new Error(
          `config.json account ${accountLabel(account)} contains duplicate repository ${normalized}`,
        );
      }
      seenRepositories.add(repositoryKey);
      return normalized;
    });

    return { ...account, repositories };
  });

  const reviewerCommand = validateReviewerCommandContract(input.reviewerCommand);
  const reviewerBackend = reviewerBackendForCommand(reviewerCommand);
  if (input.model !== undefined && input.model !== null && !reviewerBackend) {
    throw new Error(
      'config.json model settings require the generated Codex or Claude reviewer command',
    );
  }
  const model = normalizeReviewerModel(input.model, {
    backend: reviewerBackend,
  });
  const aiProcessingConsent = migration.legacyConsentGranted
    ? createAiProcessingConsent(reviewerCommand, githubAccounts)
    : normalizeAiProcessingConsent(input.aiProcessingConsent);

  return {
    configVersion: CONFIG_VERSION,
    githubAccounts,
    aiProcessingConsent,
    reviewerCommand,
    model,
    reviewerInputMode: 'stdin',
    reviewBatchSize: resolveReviewBatchSize(input.reviewBatchSize),
    reviewFocusCount: resolveReviewFocusCount(input.reviewFocusCount),
    desktopNotifications: input.desktopNotifications !== false,
    stateFile: input.stateFile?.trim() || './state.json',
  };
}

export async function loadConfig(configPath) {
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
    await enforcePrivateMode(configPath, PRIVATE_FILE_MODE);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`no config found at ${configPath}; run \`openmergelens init\` first`);
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }
  return validateConfig(parsed);
}

export async function saveConfig(configPath, input) {
  const config = validateConfig(input);
  await ensurePrivateDirectory(path.dirname(configPath));
  const temporaryPath = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(
      temporaryPath,
      JSON.stringify(config, null, 2) + '\n',
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: PRIVATE_FILE_MODE,
      },
    );
    await rename(temporaryPath, configPath);
    await enforcePrivateMode(configPath, PRIVATE_FILE_MODE);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return config;
}
