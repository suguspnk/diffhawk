import { readFile } from 'node:fs/promises';
import {
  createReviewMarker,
  currentUsername,
  getPullRequest,
  getPullRequestDiff,
  postReview,
  reviewAlreadyPosted,
  searchReviewRequestedPRs,
} from './github.mjs';
import { resolveGitHubAuth } from './github-auth.mjs';
import { accountLabel } from './config.mjs';
import { readLearnings } from './learnings.mjs';
import { appendFailure } from './logging.mjs';
import { processInBatches } from './poll-batching.mjs';
import {
  roundRobinAccountQueues,
  selectConfiguredAccounts,
} from './poll-queue.mjs';
import { ensureReviewPrompt } from './review-prompts.mjs';
import { invokeMultiPassReview } from './reviewer-adapter.mjs';
import {
  loadState,
  needsReview,
  prKey,
  recordReview,
  saveState,
} from './state.mjs';

function accountLogger(account) {
  const label = accountLabel(account);
  return {
    label,
    info(message) {
      console.log(`[${label}] ${message}`);
    },
  };
}

async function timedStep(logger, message, fn) {
  logger.info(`${message}...`);
  const start = Date.now();
  const result = await fn();
  logger.info(`${message}: done (${Date.now() - start}ms)`);
  return result;
}

export async function pollOnce({
  config,
  stateFile,
  logPath,
  defaultReviewPromptPath,
  dryRun = false,
  accountSelector,
  dependencies = {},
}) {
  const services = {
    resolveGitHubAuth,
    currentUsername,
    searchReviewRequestedPRs,
    getPullRequest,
    getPullRequestDiff,
    createReviewMarker,
    reviewAlreadyPosted,
    ensureReviewPrompt,
    readPrompt: (promptPath) => readFile(promptPath, 'utf8'),
    readLearnings,
    invokeMultiPassReview,
    postReview,
    loadState,
    saveState,
    ...dependencies,
  };
  const accounts = selectConfiguredAccounts(config.githubAccounts, accountSelector);
  const state = await services.loadState(stateFile);
  let failed = false;
  const accountQueues = [];

  for (const account of accounts) {
    const logger = accountLogger(account);
    let auth;
    try {
      auth = await services.resolveGitHubAuth(account);
      const authenticatedUsername = await services.currentUsername({ auth });
      if (authenticatedUsername.toLowerCase() !== account.username.toLowerCase()) {
        throw new Error(
          `configured username is ${account.username}, but the credential belongs to ${authenticatedUsername}`,
        );
      }
      logger.info(`authenticated for ${account.repositories.length} repository target(s)`);
    } catch (err) {
      failed = true;
      await appendFailure(logPath, logger.label, `account unavailable: ${err.message}`);
      continue;
    }

    const items = [];
    const queued = new Set();
    for (const repo of account.repositories) {
      let candidates;
      try {
        candidates = await timedStep(
          logger,
          `searching ${repo}`,
          () => services.searchReviewRequestedPRs({
            username: account.username,
            repo,
            auth,
          }),
        );
      } catch (err) {
        failed = true;
        await appendFailure(logPath, logger.label, `search failed for ${repo}: ${err.message}`);
        continue;
      }

      if (candidates.length === 0) {
        logger.info(`no PRs awaiting review in ${repo}`);
      }
      for (const candidate of candidates) {
        const candidateKey = `${candidate.repo.toLowerCase()}#${candidate.number}`;
        if (queued.has(candidateKey)) continue;
        queued.add(candidateKey);
        items.push({ ...candidate, auth });
      }
    }
    accountQueues.push({ account, items });
  }

  const reviewQueue = roundRobinAccountQueues(accountQueues);
  if (reviewQueue.length === 0) {
    console.log('poll complete');
    return { failed, reviewed: 0 };
  }

  console.log(
    `processing ${reviewQueue.length} candidate PR(s) with global batch size ${config.reviewBatchSize}`,
  );

  let stateWriteQueue = Promise.resolve();
  function persistReview(key, sha) {
    const write = stateWriteQueue.then(async () => {
      recordReview(state, key, sha, new Date().toISOString());
      await services.saveState(stateFile, state);
    });
    stateWriteQueue = write.catch(() => {});
    return write;
  }

  async function reviewCandidate({ account, auth, repo, number }) {
    const logger = accountLogger(account);
    let pr;
    try {
      pr = await timedStep(
        logger,
        `fetching ${repo}#${number} metadata`,
        () => services.getPullRequest({ repo, number, auth }),
      );
    } catch (err) {
      await appendFailure(logPath, logger.label, `PR view failed for ${repo}#${number}: ${err.message}`);
      return false;
    }

    const key = prKey(repo, number, account);
    if (!needsReview(state, key, pr.headRefOid)) {
      logger.info(`skip ${repo}#${number} (already reviewed at ${pr.headRefOid})`);
      return true;
    }

    const reviewMarker = services.createReviewMarker({
      account,
      repo,
      number,
      commitId: pr.headRefOid,
    });
    try {
      const alreadyPosted = await services.reviewAlreadyPosted({
        repo,
        number,
        commitId: pr.headRefOid,
        marker: reviewMarker,
        auth,
      });
      if (alreadyPosted) {
        await persistReview(key, pr.headRefOid);
        logger.info(`reconciled existing review for ${repo}#${number}`);
        return true;
      }
    } catch (err) {
      await appendFailure(
        logPath,
        logger.label,
        `review reconciliation failed for ${repo}#${number}: ${err.message}`,
      );
      return false;
    }

    let diff;
    try {
      diff = await timedStep(
        logger,
        `fetching ${repo}#${number} diff`,
        () => services.getPullRequestDiff({ repo, number, auth }),
      );
    } catch (err) {
      await appendFailure(logPath, logger.label, `diff fetch failed for ${repo}#${number}: ${err.message}`);
      return false;
    }

    let template;
    let learnings;
    try {
      const promptPath = await services.ensureReviewPrompt(account.hostname, repo, {
        templatePath: defaultReviewPromptPath,
      });
      [template, learnings] = await Promise.all([
        services.readPrompt(promptPath),
        services.readLearnings(account, repo),
      ]);
    } catch (err) {
      await appendFailure(logPath, logger.label, `review files failed for ${repo}#${number}: ${err.message}`);
      return false;
    }

    let review;
    try {
      review = await timedStep(
        logger,
        `reviewing ${repo}#${number} (${config.reviewFocusCount} focused passes + synthesis)`,
        () => services.invokeMultiPassReview({
          reviewerCommand: config.reviewerCommand,
          template,
          learnings,
          pr,
          diff,
          reviewFocusCount: config.reviewFocusCount,
        }),
      );
    } catch (err) {
      await appendFailure(logPath, logger.label, `reviewer failed for ${repo}#${number}: ${err.message}`);
      return false;
    }

    if (dryRun) {
      logger.info(`--- dry run result for ${repo}#${number} ---`);
      console.log(review.summary);
      logger.info(`${review.findings.length} inline finding(s)`);
      return true;
    }

    try {
      await timedStep(
        logger,
        `posting ${repo}#${number} review`,
        () => services.postReview({
          repo,
          number,
          commitId: pr.headRefOid,
          body: review.summary,
          comments: review.findings,
          diff,
          marker: reviewMarker,
          auth,
        }),
      );
      await persistReview(key, pr.headRefOid);
      logger.info(`posted review for ${repo}#${number}`);
      return true;
    } catch (err) {
      await appendFailure(logPath, logger.label, `post/state failed for ${repo}#${number}: ${err.message}`);
      return false;
    }
  }

  const results = await processInBatches(
    reviewQueue,
    config.reviewBatchSize,
    reviewCandidate,
  );
  if (results.some((result) => result === false)) failed = true;
  await stateWriteQueue;

  console.log(`poll complete${failed ? ' with failures' : ''}`);
  return {
    failed,
    reviewed: results.filter(Boolean).length,
  };
}
