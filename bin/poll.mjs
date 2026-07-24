#!/usr/bin/env node
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  currentUsername,
  searchReviewRequestedPRs,
  getPullRequest,
  getPullRequestDiff,
  postReview,
} from '../lib/github.mjs';
import {
  configuredGitHubAccount,
  resolveGitHubAuth,
} from '../lib/github-auth.mjs';
import {
  loadState,
  saveState,
  prKey,
  migrateLegacyState,
  needsReview,
  recordReview,
} from '../lib/state.mjs';
import { buildPrompt, invokeReviewer, parseFindings } from '../lib/reviewer-adapter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const DRY_RUN = process.argv.includes('--dry-run');

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(rootDir, p);
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

async function logFailure(logPath, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await appendFile(logPath, line, 'utf8');
  console.error(line.trim());
}

// Logs the start of a potentially slow step (network/reviewer-CLI calls),
// so a run that appears to hang shows which step it's actually waiting on
// instead of going silent between "reviewing X" and the next printed line.
function logStep(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function timedStep(message, fn) {
  logStep(`${message}...`);
  const start = Date.now();
  const result = await fn();
  logStep(`${message}: done (${Date.now() - start}ms)`);
  return result;
}

async function main() {
  const configPath = resolvePath('config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));

  const stateFile = resolvePath(config.stateFile || './state.json');
  const logPath = resolvePath('poll.log');
  const githubAccount = configuredGitHubAccount(config);
  const githubAuth = await resolveGitHubAuth(githubAccount);
  const authenticatedUsername = await currentUsername({ auth: githubAuth });

  if (authenticatedUsername.toLowerCase() !== githubAccount.username.toLowerCase()) {
    throw new Error(
      `configured GitHub reviewer is ${githubAccount.username}, but the selected ` +
      `credential belongs to ${authenticatedUsername}`,
    );
  }

  console.log(
    `GitHub reviewer: ${authenticatedUsername} (${githubAccount.hostname})`,
  );

  const state = await loadState(stateFile);
  const usesLegacyAccountConfig = !config.githubAccount && Boolean(config.githubUsername);
  if (usesLegacyAccountConfig && migrateLegacyState(state, githubAccount) && !DRY_RUN) {
    await saveState(stateFile, state);
  }

  const targets = config.searchScope === 'global'
    ? [{ repo: null, global: true, checklistPath: config.checklistPath, learningsPath: config.learningsPath }]
    : config.pollTargets;

  if (!Array.isArray(targets) || targets.length === 0) {
    await logFailure(
      logPath,
      'config.json has no pollTargets configured (or searchScope is invalid) — nothing to poll. Run `node bin/init.mjs` or edit config.json.',
    );
    return;
  }

  for (const target of targets) {
    let candidates;
    try {
      candidates = await timedStep(
        `searching for PRs awaiting review in ${target.repo ?? '(global)'}`,
        () => searchReviewRequestedPRs({
          username: githubAccount.username,
          repo: target.repo,
          global: Boolean(target.global),
          auth: githubAuth,
        }),
      );
    } catch (err) {
      await logFailure(logPath, `search failed for ${target.repo ?? '(global)'}: ${err.message}`);
      continue;
    }

    if (candidates.length === 0) {
      console.log(`no PRs awaiting your review in ${target.repo ?? '(global)'}`);
      continue;
    }

    for (const { repo, number } of candidates) {
      let pr;
      try {
        pr = await timedStep(
          `fetching PR metadata for ${repo}#${number}`,
          () => getPullRequest({ repo, number, auth: githubAuth }),
        );
      } catch (err) {
        await logFailure(logPath, `pr view failed for ${repo}#${number}: ${err.message}`);
        continue;
      }

      const key = prKey(repo, number, githubAccount);
      if (!needsReview(state, key, pr.headRefOid)) {
        console.log(`skip ${key} (already reviewed at ${pr.headRefOid})`);
        continue;
      }

      console.log(`reviewing ${key} @ ${pr.headRefOid}`);

      let diff;
      try {
        diff = await timedStep(
          `[${key}] fetching diff`,
          () => getPullRequestDiff({ repo, number, auth: githubAuth }),
        );
      } catch (err) {
        await logFailure(logPath, `diff fetch failed for ${key}: ${err.message}`);
        continue;
      }

      // The template (not a per-repo copy) is the fallback here — this only
      // fires when config.json has no checklistPath at all (e.g. a
      // hand-edited or pre-per-repo-checklist config), and the template is
      // the one checklist file guaranteed to exist without having run init.
      const checklistPath = resolvePath(target.checklistPath || config.checklistPath || './docs/checklist.default.md');
      const learningsPath = resolvePath(target.learningsPath || config.learningsPath || './docs/learnings.md');
      const checklist = await readOptional(checklistPath);
      const learnings = await readOptional(learningsPath);

      const prompt = buildPrompt({ checklist, learnings, pr, diff });

      let rawOutput;
      try {
        rawOutput = await timedStep(
          `[${key}] invoking reviewer ("${config.reviewerCommand}")`,
          () => invokeReviewer({ reviewerCommand: config.reviewerCommand, prompt }),
        );
      } catch (err) {
        // Decided: log and skip posting entirely, leave state unchanged so
        // the next poll retries — never post a broken/empty review.
        await logFailure(logPath, `reviewer adapter failed for ${key}: ${err.message}`);
        continue;
      }

      const { summary, findings } = parseFindings(rawOutput);

      if (DRY_RUN) {
        console.log(`--- dry run result for ${key} ---`);
        console.log(summary);
        console.log(`${findings.length} inline finding(s)`);
        continue;
      }

      try {
        await timedStep(`[${key}] posting review`, () => postReview({
          repo,
          number,
          commitId: pr.headRefOid,
          body: summary,
          comments: findings,
          diff,
          auth: githubAuth,
        }));
      } catch (err) {
        await logFailure(logPath, `post review failed for ${key}: ${err.message}`);
        continue;
      }

      recordReview(state, key, pr.headRefOid, new Date().toISOString());
      await saveState(stateFile, state);
      console.log(`posted review for ${key}`);
    }
  }

  console.log('poll complete');
}

main().catch(async (err) => {
  // Best-effort: config.json may not have parsed, so logPath might not even
  // be resolvable — fall back to a fixed path next to this script if so.
  const fallbackLogPath = path.resolve(rootDir, 'poll.log');
  try {
    await logFailure(fallbackLogPath, `fatal: ${err.stack || err.message}`);
  } catch {
    console.error(err.stack || err.message);
  }
  process.exit(1);
});
