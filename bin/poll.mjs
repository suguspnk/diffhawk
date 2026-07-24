#!/usr/bin/env node
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  searchReviewRequestedPRs,
  getPullRequest,
  getPullRequestDiff,
  postReview,
} from '../lib/github.mjs';
import { loadState, saveState, prKey, needsReview, recordReview } from '../lib/state.mjs';
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

async function main() {
  const configPath = resolvePath('config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));

  const stateFile = resolvePath(config.stateFile || './state.json');
  const logPath = resolvePath('poll.log');
  const state = await loadState(stateFile);

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
      candidates = await searchReviewRequestedPRs({
        username: config.githubUsername,
        repo: target.repo,
        global: Boolean(target.global),
      });
    } catch (err) {
      await logFailure(logPath, `search failed for ${target.repo ?? '(global)'}: ${err.message}`);
      continue;
    }

    for (const { repo, number } of candidates) {
      let pr;
      try {
        pr = await getPullRequest({ repo, number });
      } catch (err) {
        await logFailure(logPath, `pr view failed for ${repo}#${number}: ${err.message}`);
        continue;
      }

      const key = prKey(repo, number);
      if (!needsReview(state, key, pr.headRefOid)) {
        console.log(`skip ${key} (already reviewed at ${pr.headRefOid})`);
        continue;
      }

      console.log(`reviewing ${key} @ ${pr.headRefOid}`);

      let diff;
      try {
        diff = await getPullRequestDiff({ repo, number });
      } catch (err) {
        await logFailure(logPath, `diff fetch failed for ${key}: ${err.message}`);
        continue;
      }

      const checklistPath = resolvePath(target.checklistPath || config.checklistPath || './docs/checklist.md');
      const learningsPath = resolvePath(target.learningsPath || config.learningsPath || './docs/learnings.md');
      const checklist = await readOptional(checklistPath);
      const learnings = await readOptional(learningsPath);

      const prompt = buildPrompt({ checklist, learnings, pr, diff });

      let rawOutput;
      try {
        rawOutput = await invokeReviewer({ reviewerCommand: config.reviewerCommand, prompt });
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
        await postReview({
          repo,
          number,
          commitId: pr.headRefOid,
          body: summary,
          comments: findings,
          diff,
        });
      } catch (err) {
        await logFailure(logPath, `post review failed for ${key}: ${err.message}`);
        continue;
      }

      recordReview(state, key, pr.headRefOid, new Date().toISOString());
      await saveState(stateFile, state);
      console.log(`posted review for ${key}`);
    }
  }
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
