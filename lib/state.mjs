import { readFile, writeFile } from 'node:fs/promises';

export function reviewerKey({ hostname, username }) {
  return `${hostname.toLowerCase()}@${username.toLowerCase()}`;
}

export function prKey(repo, number, reviewer) {
  const pullRequest = `${repo}#${number}`;
  return reviewer ? `${reviewerKey(reviewer)}::${pullRequest}` : pullRequest;
}

// Config files created before account pinning stored unscoped OWNER/REPO#N
// keys. When the legacy config identifies the reviewer, migrate those entries
// without changing their recorded SHA or timestamp.
export function migrateLegacyState(state, reviewer) {
  let changed = false;

  for (const [key, entry] of Object.entries(state)) {
    if (key.includes('::')) continue;

    const scopedKey = `${reviewerKey(reviewer)}::${key}`;
    if (!(scopedKey in state)) state[scopedKey] = entry;
    delete state[key];
    changed = true;
  }

  return changed;
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
