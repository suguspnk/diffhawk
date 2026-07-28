import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { accountKey } from './config.mjs';

export function reviewerKey({ hostname, username }) {
  return accountKey({ hostname, username });
}

export function prKey(repo, number, reviewer) {
  const pullRequest = `${repo}#${number}`;
  return reviewer ? `${reviewerKey(reviewer)}::${pullRequest}` : pullRequest;
}

export async function loadState(stateFile) {
  try {
    const raw = await readFile(stateFile, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveState(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const temporaryPath = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(
      temporaryPath,
      JSON.stringify(state, null, 2) + '\n',
      { encoding: 'utf8', flag: 'wx' },
    );
    await rename(temporaryPath, stateFile);
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
