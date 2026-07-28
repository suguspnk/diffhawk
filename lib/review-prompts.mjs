import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { userPath } from './paths.mjs';
import { normalizeGitHubAccount, normalizeRepository } from './config.mjs';

// One review prompt per watched repo (not one shared file) so customizing
// what openrevuwer looks for in one repo never silently changes what it
// looks for in another. Lives under the user's openrevuwer home (see
// lib/paths.mjs), not the package install dir, alongside config.json/
// state.json/the bundled-default's editable copy.
export function reviewPromptPathFor(hostname, repo) {
  const account = normalizeGitHubAccount({ hostname, username: 'path-user' });
  const normalizedRepo = normalizeRepository(repo).toLowerCase();
  const [owner, name] = normalizedRepo.split('/');
  return userPath(
    'docs',
    'review-prompts',
    account.hostname,
    owner,
    `${name}.md`,
  );
}

// Seeds a per-host/repo review prompt on first use only — never overwrites an
// existing copy, so re-running init can't clobber an edited prompt. Accounts
// on the same host share this file; each account's learnings remain separate.
export async function ensureReviewPrompt(
  hostname,
  repo,
  {
    templatePath,
    destinationPath = reviewPromptPathFor(hostname, repo),
  },
) {
  const absolutePath = destinationPath;

  try {
    await readFile(absolutePath, 'utf8');
    return absolutePath; // already exists — leave it untouched
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const template = await readFile(templatePath, 'utf8');
  await mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await writeFile(absolutePath, template, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    // Another init/poll may have seeded this repository after our initial
    // existence check. Its file wins; never overwrite content that may
    // already have been customized.
    if (err.code !== 'EEXIST') throw err;
  }
  return absolutePath;
}
