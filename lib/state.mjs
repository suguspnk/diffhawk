import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { accountKey } from './config.mjs';
import {
  enforcePrivateMode,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
} from './file-security.mjs';

export function reviewerKey({ hostname, username }) {
  return accountKey({ hostname, username });
}

export function parsePrKey(key) {
  if (typeof key !== 'string') return null;

  const scopeSeparator = key.lastIndexOf('::');
  const reviewer = scopeSeparator >= 0 ? key.slice(0, scopeSeparator) : null;
  const pullRequest = scopeSeparator >= 0 ? key.slice(scopeSeparator + 2) : key;
  const numberSeparator = pullRequest.lastIndexOf('#');
  if (numberSeparator <= 0) return null;

  const repo = pullRequest.slice(0, numberSeparator);
  const numberText = pullRequest.slice(numberSeparator + 1);
  const number = Number(numberText);
  if (!repo || !Number.isSafeInteger(number) || number <= 0) return null;

  return { reviewer, repo, number, numberText };
}

export function normalizePrKey(key) {
  const parsed = parsePrKey(key);
  if (!parsed) return key;

  const scope = parsed.reviewer === null ? '' : `${parsed.reviewer.toLowerCase()}::`;
  return `${scope}${parsed.repo.toLowerCase()}#${parsed.number}`;
}

export function prKey(repo, number, reviewer) {
  const pullRequest = `${repo.toLowerCase()}#${number}`;
  return reviewer ? `${reviewerKey(reviewer)}::${pullRequest}` : pullRequest;
}

// State written before account scoping used unscoped OWNER/REPO#N keys. An
// unscoped entry can be adopted only when the caller has identified one
// unambiguous reviewer account. Never replace an existing scoped entry: it is
// the stronger account-specific record.
export function migrateLegacyStateForReviewer(state, reviewer) {
  let changed = false;

  for (const [key, entry] of Object.entries(state)) {
    const parsed = parsePrKey(key);
    if (!parsed || parsed.reviewer !== null) continue;

    const scopedKey = prKey(parsed.repo, parsed.number, reviewer);
    if (!Object.prototype.hasOwnProperty.call(state, scopedKey)) {
      state[scopedKey] = entry;
    }
    delete state[key];
    changed = true;
  }

  return changed;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateState(state, stateFile) {
  if (!isPlainObject(state)) {
    throw new Error(`Invalid review state in ${stateFile}: expected a JSON object`);
  }

  for (const [key, entry] of Object.entries(state)) {
    if (
      !isPlainObject(entry) ||
      typeof entry.lastReviewedSha !== 'string' ||
      typeof entry.lastReviewedAt !== 'string'
    ) {
      throw new Error(
        `Invalid review state entry "${key}" in ${stateFile}: ` +
          'expected lastReviewedSha and lastReviewedAt strings',
      );
    }
  }

  return state;
}

export function normalizeState(state) {
  const normalized = {};
  const sourceKeys = new Map();
  for (const [key, entry] of Object.entries(state)) {
    const normalizedKey = normalizePrKey(key);
    const previousKey = sourceKeys.get(normalizedKey);
    if (previousKey !== undefined && !shouldPreferStateEntry(key, previousKey)) {
      continue;
    }
    sourceKeys.set(normalizedKey, key);
    Object.defineProperty(normalized, normalizedKey, {
      configurable: true,
      enumerable: true,
      value: entry,
      writable: true,
    });
  }
  return normalized;
}

function shouldPreferStateEntry(candidateKey, currentKey) {
  // Exact canonical spellings win; aliases use code-unit order so the
  // surviving entry does not depend on JSON property insertion order.
  const candidateIsCanonical = normalizePrKey(candidateKey) === candidateKey;
  const currentIsCanonical = normalizePrKey(currentKey) === currentKey;
  if (candidateIsCanonical !== currentIsCanonical) return candidateIsCanonical;
  return candidateKey < currentKey;
}

export async function loadState(stateFile, { hardenPermissions = true } = {}) {
  try {
    const raw = await readFile(stateFile, 'utf8');
    if (hardenPermissions) {
      await enforcePrivateMode(stateFile, PRIVATE_FILE_MODE);
    }
    return normalizeState(validateState(JSON.parse(raw), stateFile));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveState(stateFile, state) {
  state = normalizeState(validateState(state, stateFile));
  // stateFile may be an absolute, user-selected path outside
  // OPENMERGELENS_HOME. Create a missing parent privately, but never chmod an
  // existing parent directory that OpenMergeLens does not own.
  await mkdir(path.dirname(stateFile), {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  const temporaryPath = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(
      temporaryPath,
      JSON.stringify(state, null, 2) + '\n',
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: PRIVATE_FILE_MODE,
      },
    );
    await rename(temporaryPath, stateFile);
    await enforcePrivateMode(stateFile, PRIVATE_FILE_MODE);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function needsReview(state, key, currentSha) {
  const entry = state[normalizePrKey(key)];
  if (!entry) return true;
  return entry.lastReviewedSha !== currentSha;
}

export function recordReview(state, key, sha, reviewedAt) {
  state[normalizePrKey(key)] = {
    lastReviewedSha: sha,
    lastReviewedAt: reviewedAt,
  };
}
