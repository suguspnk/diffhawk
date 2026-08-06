import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiProcessingConsent } from '../lib/ai-processing-consent.mjs';
import {
  currentUsername,
  createReviewMarker,
  getPullRequest,
  reviewAlreadyPosted,
  searchReviewRequestedPRs,
} from '../lib/github.mjs';
import { resolveGitHubAuth } from '../lib/github-auth.mjs';
import { saveConfig } from '../lib/config.mjs';
import { prKey } from '../lib/state.mjs';
import {
  calculateLiveReviewWatchdogMs,
  parseEnvironment,
} from './live-review-config.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const environment = parseEnvironment();

if (environment.error) {
  test('live review E2E configuration', () => {
    assert.fail(environment.error);
  });
} else {
  test(
    `runs a real GitHub-backed OpenMergeLens review with ${environment.reviewerBackend}`,
    async (t) => {
      const account = {
        hostname: environment.host,
        username: environment.username,
      };
      const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-e2e-'));
      const home = path.join(root, 'home');
      await mkdir(home, { recursive: true });
      t.after(async () => {
        if (environment.keepHome) {
          console.error(`OpenMergeLens E2E state retained at ${home}`);
          return;
        }
        await rm(root, { recursive: true, force: true });
      });

      const auth = await resolveGitHubAuth(account);
      assert.equal(
        (await currentUsername({ auth })).toLowerCase(),
        environment.username.toLowerCase(),
        'configured E2E username does not match the selected gh credential',
      );

      const pullRequest = await getPullRequest({
        repo: environment.repository,
        number: environment.number,
        auth,
      });
      assert.equal(pullRequest.number, environment.number);
      assert.equal(pullRequest.state, 'OPEN', 'E2E PR must be open');
      assert.ok(pullRequest.headRefOid, 'E2E PR must have a head commit');

      const requested = await searchReviewRequestedPRs({
        username: environment.username,
        repo: environment.repository,
        auth,
      });
      assert.ok(
        requested.some((candidate) => candidate.number === environment.number),
        `E2E PR ${environment.repository}#${environment.number} must request ` +
          `review from ${environment.username}`,
      );

      const marker = createReviewMarker({
        account,
        repo: environment.repository,
        number: environment.number,
        commitId: pullRequest.headRefOid,
      });
      assert.equal(
        await reviewAlreadyPosted({
          repo: environment.repository,
          number: environment.number,
          commitId: pullRequest.headRefOid,
          marker,
          auth,
        }),
        false,
        'E2E PR head already has an OpenMergeLens review; use a fresh test commit',
      );

      await saveConfig(path.join(home, 'config.json'), {
        configVersion: 5,
        githubAccounts: [{
          ...account,
          repositories: [environment.repository],
        }],
        reviewerCommand: environment.reviewerCommand,
        aiProcessingConsent: createAiProcessingConsent(
          environment.reviewerCommand,
          [{ ...account, repositories: [environment.repository] }],
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
      assert.equal(completed.count, 1);
      assert.ok(
        records.some((record) =>
          record.message?.includes(`${environment.repository}#${environment.number}`) &&
          record.message?.includes(
            environment.mode === 'dry-run' ? 'dry run result' : 'posted review',
          )),
        'poll.log must show the target review reached its terminal step',
      );

      const posted = await reviewAlreadyPosted({
        repo: environment.repository,
        number: environment.number,
        commitId: pullRequest.headRefOid,
        marker,
        auth,
      });
      if (environment.mode === 'dry-run') {
        assert.equal(posted, false, 'dry-run must not create a GitHub review');
        await assert.rejects(readFile(path.join(home, 'state.json')), { code: 'ENOENT' });
        return;
      }

      assert.equal(posted, true, 'post mode must create a review with the OpenMergeLens marker');
      const state = JSON.parse(await readFile(path.join(home, 'state.json'), 'utf8'));
      assert.equal(
        state[prKey(environment.repository, environment.number, account)]?.lastReviewedSha,
        pullRequest.headRefOid,
      );
    },
  );
}
