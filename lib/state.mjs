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

export function prKey(repo, number, reviewer) {
  const pullRequest = `${repo}#${number}`;
  return reviewer ? `${reviewerKey(reviewer)}::${pullRequest}` : pullRequest;
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

export async function loadState(stateFile) {
  try {
    const raw = await readFile(stateFile, 'utf8');
    await enforcePrivateMode(stateFile, PRIVATE_FILE_MODE);
    return validateState(JSON.parse(raw), stateFile);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveState(stateFile, state) {
  validateState(state, stateFile);
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
  const entry = state[key];
  if (!entry) return true;
  return entry.lastReviewedSha !== currentSha;
}

export function recordReview(state, key, sha, reviewedAt) {
  state[key] = {
    lastReviewedSha: sha,
    lastReviewedAt: reviewedAt,
  };
}
