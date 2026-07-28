import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeGitHubAccount,
  normalizeRepository,
} from './config.mjs';
import { userPath } from './paths.mjs';

export function learningsPathFor(account, repo) {
  const { hostname, username } = normalizeGitHubAccount(account);
  const [owner, name] = normalizeRepository(repo).toLowerCase().split('/');
  return userPath(
    'docs',
    'learnings',
    hostname,
    username.toLowerCase(),
    owner,
    `${name}.md`,
  );
}

export async function ensureLearningsFile(account, repo) {
  const filePath = learningsPathFor(account, repo);
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, '', { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return filePath;
}

export async function readLearnings(account, repo) {
  const filePath = learningsPathFor(account, repo);
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}
