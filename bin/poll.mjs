#!/usr/bin/env node
import { readFile, appendFile, mkdir } from 'node:fs/promises';
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
import { acquireLock } from '../lib/lock.mjs';
import {
  ensureReviewPrompt,
  reviewPromptProvisioning,
} from '../lib/review-prompts.mjs';
import { userPath, resolveUserPath } from '../lib/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(__dirname, '..');
const defaultReviewPromptPath = path.join(
  packageRootDir,
  'docs',
  'review-prompt.default.md',
);

const DRY_RUN = process.argv.includes('--dry-run');

// Relative paths in config.json (checklistPath, learningsPath, stateFile) are
// resolved against the user's openrevuwer home, not the package install dir —
// see lib/paths.mjs for why.
const resolvePath = resolveUserPath;

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
  await mkdir(userPath(), { recursive: true });

  const configPath = resolvePath('config.json');
  let configRaw;
  try {
    configRaw = await readFile(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`no config found at ${configPath} — run \`openrevuwer init\` first`);
    }
    throw err;
  }
  const config = JSON.parse(configRaw);

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

  // Guards state.json's read-then-write cycle below against a second,
  // overlapping poll run (e.g. a slow reviewer CLI still in flight when the
  // next scheduled tick fires) racing on the same file.
  const lockKey = resolvePath(config.lockFile || `${stateFile}.lock`);
  const releaseLock = await acquireLock(lockKey);
  if (!releaseLock) {
    console.log(`another poll run holds ${lockKey} — skipping this tick`);
    return;
  }

  try {
    await pollOnce({
      config,
      configPath,
      stateFile,
      logPath,
      githubAccount,
      githubAuth,
    });
  } finally {
    await releaseLock();
  }
}

async function pollOnce({
  config,
  configPath,
  stateFile,
  logPath,
  githubAccount,
  githubAuth,
}) {
  const state = await loadState(stateFile);
  const usesLegacyAccountConfig = !config.githubAccount && Boolean(config.githubUsername);
  if (usesLegacyAccountConfig && migrateLegacyState(state, githubAccount) && !DRY_RUN) {
    await saveState(stateFile, state);
  }

  const targets = config.searchScope === 'global'
    ? [{
        repo: null,
        global: true,
        reviewPromptPath: config.reviewPromptPath,
        checklistPath: config.checklistPath,
        learningsPath: config.learningsPath,
      }]
    : config.pollTargets;

  if (!Array.isArray(targets) || targets.length === 0) {
    await logFailure(
      logPath,
      `config.json has no pollTargets configured (or searchScope is invalid) — nothing to poll. Run \`openrevuwer init\` or edit ${configPath}.`,
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

      // The bundled default (packageRootDir, not the user's openrevuwer
      // home) is the fallback here — this only fires when config.json has
      // no reviewPromptPath at all (e.g. a hand-edited config), and the
      // bundled default is the one review-prompt file guaranteed to exist
      // without having run init.
      //
      // "checklistPath" (this key's name before this change) is still read
      // as a fallback for one more release. Unlike the earlier repo-root
      // diffhawk era (whose paths resolved against a different base and
      // are a separate, already-documented no-automatic-migration case —
      // see README's "Upgrading from a local diffhawk clone" note), a
      // config written under the current ~/.openrevuwer/ model with
      // "checklistPath": "./docs/checklist.md" still resolves to a real,
      // existing file (init seeded it there before this change), so it's
      // read as-is here rather than redirected. Its CONTENT is old-format
      // (a plain criteria list, no {{diff}} placeholder) though — buildPrompt
      // detects that and wraps it with the old fixed framing/sections
      // instead of running placeholder substitution on it, so this old
      // file keeps producing a working prompt without needing migration.
      //
      // Global search discovers repositories only at poll time. Seed each
      // discovered repo's independent prompt lazily, using a configured
      // shared/legacy prompt only as its initial content. Subsequent edits
      // remain isolated to that repository.
      const provisioning = reviewPromptProvisioning(config, target, resolvePath);
      const reviewPromptPath = await ensureReviewPrompt(repo, {
        templatePath: defaultReviewPromptPath,
        ...provisioning,
      });
      const learningsPath = resolvePath(target.learningsPath || config.learningsPath || './docs/learnings.md');
      const template = await readOptional(reviewPromptPath);
      const learnings = await readOptional(learningsPath);

      const prompt = buildPrompt({ template, learnings, pr, diff });

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
  // be resolvable — fall back to a fixed path in the user's openrevuwer home.
  const fallbackLogPath = userPath('poll.log');
  try {
    await mkdir(userPath(), { recursive: true });
    await logFailure(fallbackLogPath, `fatal: ${err.stack || err.message}`);
  } catch {
    console.error(err.stack || err.message);
  }
  process.exit(1);
});
