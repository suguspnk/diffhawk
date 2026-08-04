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
import { authEnvironment, resolveGitHubAuth } from './github-auth.mjs';
import { hasAiProcessingConsent } from './ai-processing-consent.mjs';
import { accountLabel } from './config.mjs';
import { createGitHubMutationQueue } from './github-mutation-queue.mjs';
import { readLearnings } from './learnings.mjs';
import { appendFailure } from './logging.mjs';
import { processInBatches } from './poll-batching.mjs';
import {
  roundRobinAccountQueues,
  selectConfiguredAccounts,
} from './poll-queue.mjs';
import { ensureReviewPrompt } from './review-prompts.mjs';
import { invokeMultiPassReview } from './reviewer-adapter.mjs';
import { reviewerCommandForGitHubHost } from './reviewer-command-defaults.mjs';
import { describeReviewerModel } from './reviewer-models.mjs';
import { buildReviewerEnvironment } from './reviewer-security.mjs';
import {
  MAX_REVIEWS_PER_POLL,
} from './security-limits.mjs';
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
    createGitHubMutationQueue,
    loadState,
    saveState,
    ...dependencies,
  };
  const accounts = selectConfiguredAccounts(config.githubAccounts, accountSelector);
  const mutationQueue = services.createGitHubMutationQueue();
  const state = await services.loadState(stateFile);
  let failed = false;
  const accountQueues = [];
  const failures = [];

  async function recordFailure(entry, label, message) {
    failed = true;
    const failure = { status: 'failed', ...entry };
    failures.push(failure);
    await appendFailure(logPath, label, message);
    return failure;
  }

  for (const account of accounts) {
    const logger = accountLogger(account);
    if (!hasAiProcessingConsent(config)) {
      await recordFailure(
        {
          subject: logger.label,
          account: logger.label,
          note: 'AI-processing consent required',
        },
        logger.label,
        'AI-processing consent is missing for all selected repositories; ' +
          'rerun `openmergelens init`',
      );
      continue;
    }
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
      await recordFailure(
        {
          subject: logger.label,
          account: logger.label,
          note: 'authentication failed',
        },
        logger.label,
        `account unavailable: ${err.message}`,
      );
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
        await recordFailure(
          {
            subject: repo,
            account: logger.label,
            note: 'search failed',
          },
          logger.label,
          `search failed for ${repo}: ${err.message}`,
        );
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

  let reviewQueue = roundRobinAccountQueues(accountQueues);
  if (reviewQueue.length > MAX_REVIEWS_PER_POLL) {
    failed = true;
    const skipped = reviewQueue.length - MAX_REVIEWS_PER_POLL;
    failures.push({
      status: 'failed',
      subject: 'review queue',
      note: `${skipped} candidate(s) deferred by safety limit`,
    });
    await appendFailure(
      logPath,
      'safety',
      `review queue contained ${reviewQueue.length} candidates; ` +
      `processing the first ${MAX_REVIEWS_PER_POLL} and deferring ${skipped}`,
    );
    reviewQueue = reviewQueue.slice(0, MAX_REVIEWS_PER_POLL);
  }
  if (reviewQueue.length === 0) {
    console.log('poll complete');
    return { failed, reviewed: 0, outcomes: [], failures };
  }

  console.log(
    `processing ${reviewQueue.length} candidate PR(s) with global batch size ${config.reviewBatchSize}`,
  );

  let stateWriteQueue = Promise.resolve();
  function persistReview(key, sha) {
    const write = stateWriteQueue.then(async () => {
      const previous = state[key];
      recordReview(state, key, sha, new Date().toISOString());
      try {
        await services.saveState(stateFile, state);
      } catch (err) {
        if (previous === undefined) delete state[key];
        else state[key] = previous;
        throw err;
      }
    });
    stateWriteQueue = write.catch(() => {});
    return write;
  }

  async function reviewCandidate({ account, auth, repo, number }) {
    const logger = accountLogger(account);
    const baseEntry = {
      repo,
      number,
      account: logger.label,
      hostname: auth.hostname,
    };
    let pr;
    try {
      pr = await timedStep(
        logger,
        `fetching ${repo}#${number} metadata`,
        () => services.getPullRequest({ repo, number, auth }),
      );
    } catch (err) {
      return recordFailure(
        { ...baseEntry, note: 'metadata fetch failed' },
        logger.label,
        `PR view failed for ${repo}#${number}: ${err.message}`,
      );
    }
    if (pr.state !== 'OPEN') {
      logger.info(`skip ${repo}#${number} (state: ${pr.state ?? 'unknown'})`);
      return null;
    }

    const key = prKey(repo, number, account);
    const hadPreviousReview = state[key] !== undefined;
    if (!needsReview(state, key, pr.headRefOid)) {
      logger.info(`skip ${repo}#${number} (already reviewed at ${pr.headRefOid})`);
      return null;
    }

    const prEntry = {
      ...baseEntry,
      title: pr.title,
      url: pr.url,
    };
    const reviewMarker = services.createReviewMarker({
      account,
      repo,
      number,
      commitId: pr.headRefOid,
    });
    let alreadyPosted;
    try {
      alreadyPosted = await services.reviewAlreadyPosted({
        repo,
        number,
        commitId: pr.headRefOid,
        marker: reviewMarker,
        auth,
      });
    } catch (err) {
      return recordFailure(
        { ...prEntry, note: 'review reconciliation failed' },
        logger.label,
        `review reconciliation failed for ${repo}#${number}: ${err.message}`,
      );
    }
    if (alreadyPosted) {
      try {
        await persistReview(key, pr.headRefOid);
        logger.info(`reconciled existing review for ${repo}#${number}`);
        return { status: 'recovered', ...prEntry };
      } catch (err) {
        return recordFailure(
          { ...prEntry, note: 'tracking recovery failed' },
          logger.label,
          `review reconciliation state failed for ${repo}#${number}: ${err.message}`,
        );
      }
    }

    let diff;
    try {
      diff = await timedStep(
        logger,
        `fetching ${repo}#${number} diff`,
        () => services.getPullRequestDiff({ repo, number, auth }),
      );
    } catch (err) {
      return recordFailure(
        { ...prEntry, note: 'diff fetch failed' },
        logger.label,
        `diff fetch failed for ${repo}#${number}: ${err.message}`,
      );
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
      return recordFailure(
        { ...prEntry, note: 'review files failed' },
        logger.label,
        `review files failed for ${repo}#${number}: ${err.message}`,
      );
    }

    let review;
    try {
      review = await timedStep(
        logger,
        `reviewing ${repo}#${number} (${config.reviewFocusCount} focused passes + synthesis; model: ${describeReviewerModel(config.model)})`,
        () => {
          const reviewerCommand = reviewerCommandForGitHubHost(
            config.reviewerCommand,
            auth.hostname,
          );
          return services.invokeMultiPassReview({
            reviewerCommand,
            model: config.model,
            template,
            learnings,
            pr,
            reviewFocusCount: config.reviewFocusCount,
            environment: buildReviewerEnvironment(
              reviewerCommand,
              authEnvironment(auth),
            ),
            githubAccess: {
              repo,
              number,
              headRefOid: pr.headRefOid,
              url: pr.url,
              environment: authEnvironment(auth),
            },
            onDiagnostic: (message) => logger.info(
              `reviewing ${repo}#${number}: ${message}`,
            ),
          });
        },
      );
    } catch (err) {
      return recordFailure(
        { ...prEntry, note: 'reviewer failed' },
        logger.label,
        `reviewer failed for ${repo}#${number}: ${err.message}`,
      );
    }

    if (dryRun) {
      logger.info(`--- dry run result for ${repo}#${number} ---`);
      console.log(review.summary);
      logger.info(`${review.findings.length} inline finding(s)`);
      return {
        status: 'dry-run',
        ...prEntry,
        note: hadPreviousReview ? 'new commits' : undefined,
      };
    }

    let currentPr;
    try {
      currentPr = await timedStep(
        logger,
        `confirming ${repo}#${number} head commit`,
        () => services.getPullRequest({ repo, number, auth }),
      );
    } catch (err) {
      return recordFailure(
        { ...prEntry, note: 'head verification failed' },
        logger.label,
        `head verification failed for ${repo}#${number}: ${err.message}`,
      );
    }
    if (currentPr.state !== 'OPEN') {
      logger.info(
        `skip ${repo}#${number} before posting (state: ${currentPr.state ?? 'unknown'})`,
      );
      return null;
    }
    if (currentPr.headRefOid !== pr.headRefOid) {
      return recordFailure(
        { ...prEntry, note: 'new commits during review' },
        logger.label,
        `head changed during review for ${repo}#${number}: ` +
        `${pr.headRefOid} -> ${currentPr.headRefOid}; skipping stale review`,
      );
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
          scheduleMutation: (operation) => mutationQueue.run(operation),
        }),
      );
    } catch (err) {
      return recordFailure(
        { ...prEntry, note: 'review post failed' },
        logger.label,
        `post failed for ${repo}#${number}: ${err.message}`,
      );
    }

    try {
      await persistReview(key, pr.headRefOid);
      logger.info(`posted review for ${repo}#${number}`);
    } catch (err) {
      failed = true;
      const trackingFailure = {
        status: 'tracking-failed',
        ...prEntry,
        note: 'will reconcile',
      };
      failures.push(trackingFailure);
      await appendFailure(
        logPath,
        logger.label,
        `state failed after posting ${repo}#${number}: ${err.message}`,
      );
      return trackingFailure;
    }
    return {
      status: hadPreviousReview ? 're-reviewed' : 'reviewed',
      ...prEntry,
    };
  }

  const results = await processInBatches(
    reviewQueue,
    config.reviewBatchSize,
    reviewCandidate,
  );
  await stateWriteQueue;
  const outcomes = results.filter(
    (result) =>
      result &&
      result.status !== 'failed' &&
      result.status !== 'tracking-failed',
  );

  console.log(`poll complete${failed ? ' with failures' : ''}`);
  return {
    failed,
    reviewed: outcomes.length,
    outcomes,
    failures,
  };
}
