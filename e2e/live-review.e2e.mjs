import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiProcessingConsent } from '../lib/ai-processing-consent.mjs';
import {
  createReviewMarker,
  currentUsername,
  getPullRequest,
  reviewAlreadyPosted,
  searchReviewRequestedPRs,
} from '../lib/github.mjs';
import { resolveGitHubAuth } from '../lib/github-auth.mjs';
import { saveConfig } from '../lib/config.mjs';
import { prKey } from '../lib/state.mjs';
import {
  closeDisposablePullRequest,
  createDisposablePullRequest,
  inlineCommentExists,
  listPullRequestReviewComments,
  listPullRequestReviews,
} from './live-review-github.mjs';
import {
  calculateLiveReviewWatchdogMs,
  parseEnvironment,
} from './live-review-config.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GITHUB_EVENTUAL_CONSISTENCY_TIMEOUT_MS = 30_000;
const GITHUB_EVENTUAL_CONSISTENCY_INTERVAL_MS = 1_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseJsonLines(contents, logPath) {
  const lines = contents.trim().split('\n').filter(Boolean);
  assert.ok(lines.length > 0, `${logPath} is empty`);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      assert.fail(`${logPath} line ${index + 1} is not valid JSONL: ${error.message}`);
    }
  });
}

function runPoll({ home, mode, reviewFocusCount, reviewTimeoutMs }) {
  const args = ['bin/poll.mjs'];
  if (mode === 'dry-run') args.push('--dry-run');
  const timeout = calculateLiveReviewWatchdogMs({
    reviewFocusCount,
    reviewTimeoutMs,
  });

  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        OPENMERGELENS_HOME: home,
        OPENMERGELENS_DESKTOP_NOTIFICATIONS: '0',
        GH_PROMPT_DISABLED: '1',
      },
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && error.code === 'ETIMEDOUT') {
        reject(new Error(`poll E2E timed out after ${timeout}ms`));
        return;
      }
      resolve({
        code: error ? error.code : 0,
        signal: error?.signal ?? null,
        stdout,
        stderr,
      });
    });
    child.once('error', reject);
  });
}

async function waitForRequestedReview({ repo, number, username, auth }) {
  const deadline = Date.now() + GITHUB_EVENTUAL_CONSISTENCY_TIMEOUT_MS;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const requested = await searchReviewRequestedPRs({ username, repo, auth });
      if (requested.some((candidate) => candidate.number === number)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(GITHUB_EVENTUAL_CONSISTENCY_INTERVAL_MS);
  }
  throw new Error(
    `E2E PR ${repo}#${number} did not become review-requested for ${username}` +
      (lastError ? `: ${lastError.message}` : ''),
  );
}

async function waitForInlineReview({
  repo,
  number,
  marker,
  commitId,
  reviewerUsername,
  auth,
}) {
  const deadline = Date.now() + GITHUB_EVENTUAL_CONSISTENCY_TIMEOUT_MS;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const reviews = await listPullRequestReviews({ repo, number, auth });
      const markerReview = reviews.find((review) =>
        review.body?.includes(marker) &&
        review.commit_id === commitId &&
        review.state !== 'PENDING' &&
        review.user_login?.toLowerCase() === reviewerUsername.toLowerCase(),
      );
      if (markerReview) {
        const comments = await listPullRequestReviewComments({ repo, number, auth });
        if (inlineCommentExists(markerReview, comments)) {
          return { markerReview, comments };
        }
      }
    } catch (error) {
      lastError = error;
    }
    await delay(GITHUB_EVENTUAL_CONSISTENCY_INTERVAL_MS);
  }
  throw new Error(
    `posted review for ${repo}#${number} did not expose an inline comment` +
      (lastError ? `: ${lastError.message}` : ''),
  );
}

const environment = parseEnvironment();

if (environment.error) {
  test('live review E2E configuration', () => {
    assert.fail(environment.error);
  });
} else {
  test(
    `creates and reviews a disposable GitHub PR with ${environment.reviewerBackend}`,
    async (t) => {
      const reviewerAccount = {
        hostname: environment.host,
        username: environment.username,
      };
      const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-e2e-'));
      const home = path.join(root, 'home');
      await mkdir(home, { recursive: true });
      let disposablePullRequest;
      let authorAuth;

      t.after(async () => {
        const cleanupErrors = [];
        if (disposablePullRequest && !environment.keepPr) {
          try {
            await closeDisposablePullRequest({
              repo: disposablePullRequest.repo,
              number: disposablePullRequest.number,
              branch: disposablePullRequest.branch,
              auth: authorAuth,
            });
          } catch (error) {
            cleanupErrors.push(error);
            console.error(
              `OpenMergeLens E2E cleanup failed for ${disposablePullRequest.url ||
                `${environment.repository}#${disposablePullRequest.number}`}: ${error.message}`,
            );
          }
        } else if (disposablePullRequest) {
          console.error(
            `OpenMergeLens E2E PR retained at ${disposablePullRequest.url ||
              `${environment.repository}#${disposablePullRequest.number}`}`,
          );
        }
        if (environment.keepHome) {
          console.error(`OpenMergeLens E2E state retained at ${home}`);
        } else {
          try {
            await rm(root, { recursive: true, force: true });
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (cleanupErrors.length > 0) {
          throw new Error(cleanupErrors.map((error) => error.message).join('; '));
        }
      });

      const reviewerAuth = await resolveGitHubAuth(reviewerAccount);
      assert.equal(
        (await currentUsername({ auth: reviewerAuth })).toLowerCase(),
        environment.username.toLowerCase(),
        'configured reviewer username does not match the selected gh credential',
      );

      if (environment.provision) {
        authorAuth = await resolveGitHubAuth({
          hostname: environment.host,
          username: environment.authorUsername,
        });
        assert.equal(
          (await currentUsername({ auth: authorAuth })).toLowerCase(),
          environment.authorUsername.toLowerCase(),
          'configured author username does not match the selected gh credential',
        );
        disposablePullRequest = await createDisposablePullRequest({
          repo: environment.repository,
          reviewerUsername: environment.username,
          authorAuth,
          baseBranch: environment.baseBranch,
        });
      }

      const number = disposablePullRequest?.number ?? environment.number;
      const pullRequest = await getPullRequest({
        repo: environment.repository,
        number,
        auth: reviewerAuth,
      });
      assert.equal(pullRequest.number, number);
      assert.equal(pullRequest.state, 'OPEN', 'E2E PR must be open');
      assert.ok(pullRequest.headRefOid, 'E2E PR must have a head commit');

      await waitForRequestedReview({
        username: environment.username,
        repo: environment.repository,
        number,
        auth: reviewerAuth,
      });

      const marker = createReviewMarker({
        account: reviewerAccount,
        repo: environment.repository,
        number,
        commitId: pullRequest.headRefOid,
      });
      assert.equal(
        await reviewAlreadyPosted({
          repo: environment.repository,
          number,
          commitId: pullRequest.headRefOid,
          marker,
          auth: reviewerAuth,
        }),
        false,
        'E2E PR head already has an OpenMergeLens review; use a fresh test PR or commit',
      );

      await saveConfig(path.join(home, 'config.json'), {
        configVersion: 5,
        githubAccounts: [{
          ...reviewerAccount,
          repositories: [environment.repository],
        }],
        reviewerCommand: environment.reviewerCommand,
        aiProcessingConsent: createAiProcessingConsent(
          environment.reviewerCommand,
          [{ ...reviewerAccount, repositories: [environment.repository] }],
        ),
        model: null,
        reviewerInputMode: 'stdin',
        reviewBatchSize: 1,
        reviewFocusCount: environment.reviewFocusCount,
        reviewTimeoutMs: environment.reviewTimeoutMs,
        desktopNotifications: false,
        stateFile: './state.json',
      });

      const result = await runPoll({
        home,
        mode: environment.mode,
        reviewFocusCount: environment.reviewFocusCount,
        reviewTimeoutMs: environment.reviewTimeoutMs,
      });
      const logPath = path.join(home, 'poll.log');
      const records = parseJsonLines(await readFile(logPath, 'utf8'), logPath);
      const completed = records.find((record) => record.event === 'poll.completed');
      assert.equal(result.code, 0, `poll exited with ${result.code}; inspect ${logPath}`);
      assert.equal(result.signal, null);
      assert.ok(completed, 'poll.log must contain poll.completed');
      assert.equal(completed.status, 'ok');
      assert.ok(completed.count >= 1, 'poll.completed must include the target PR');
      assert.ok(
        records.some((record) =>
          record.message?.includes(`${environment.repository}#${number}`) &&
          record.message?.includes(
            environment.mode === 'dry-run' ? 'dry run result' : 'posted review',
          )),
        'poll.log must show the target review reached its terminal step',
      );

      if (environment.mode === 'dry-run') {
        const posted = await reviewAlreadyPosted({
          repo: environment.repository,
          number,
          commitId: pullRequest.headRefOid,
          marker,
          auth: reviewerAuth,
        });
        assert.equal(posted, false, 'dry-run must not create a GitHub review');
        await assert.rejects(readFile(path.join(home, 'state.json')), { code: 'ENOENT' });
        return;
      }

      const { markerReview } = await waitForInlineReview({
        repo: environment.repository,
        number,
        marker,
        commitId: pullRequest.headRefOid,
        reviewerUsername: environment.username,
        auth: reviewerAuth,
      });
      assert.ok(markerReview, 'posted review must be visible through the GitHub reviews API');

      const state = JSON.parse(await readFile(path.join(home, 'state.json'), 'utf8'));
      assert.equal(
        state[prKey(environment.repository, number, reviewerAccount)]?.lastReviewedSha,
        pullRequest.headRefOid,
      );
    },
  );
}
