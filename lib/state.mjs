import { readFile, writeFile } from 'node:fs/promises';

export function prKey(repo, number) {
  return `${repo}#${number}`;
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
  await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
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
