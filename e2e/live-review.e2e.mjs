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
import { validateReviewerCommandContract } from '../lib/reviewer-command-defaults.mjs';
import { prKey } from '../lib/state.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POST_CONFIRMATION = 'I_UNDERSTAND_POSTING_TO_TEST_PR';

function parsePositiveInteger(value, name) {
  if (!/^\d+$/u.test(value || '')) {
    throw new Error(`${name} must be a positive whole number`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return parsed;
}

function parseBoundedInteger(value, name, minimum, maximum, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = parsePositiveInteger(value, name);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseEnvironment(environment = process.env) {
  const missing = [
    'OPENMERGELENS_E2E_REPO',
    'OPENMERGELENS_E2E_PR',
    'OPENMERGELENS_E2E_USERNAME',
    'OPENMERGELENS_E2E_REVIEWER_COMMAND',
  ].filter((key) => !environment[key]?.trim());
  if (missing.length > 0) {
    return {
      error: [
        'Live review E2E is intentionally opt-in.',
        `Set: ${missing.join(', ')}.`,
        'See e2e/README.md for the required test-PR and reviewer setup.',
      ].join(' '),
    };
  }

  try {
    const mode = environment.OPENMERGELENS_E2E_MODE || 'dry-run';
    if (mode !== 'dry-run' && mode !== 'post') {
      throw new Error('OPENMERGELENS_E2E_MODE must be dry-run or post');
    }
    if (
      mode === 'post' &&
      environment.OPENMERGELENS_E2E_POST_CONFIRM !== POST_CONFIRMATION
    ) {
      throw new Error(
        `Posting requires OPENMERGELENS_E2E_POST_CONFIRM=${POST_CONFIRMATION}`,
      );
    }

    const host = environment.OPENMERGELENS_E2E_HOST || 'github.com';
    const repository = environment.OPENMERGELENS_E2E_REPO.trim();
    if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
      throw new Error('OPENMERGELENS_E2E_REPO must be OWNER/REPO');
    }
    const number = parsePositiveInteger(
      environment.OPENMERGELENS_E2E_PR,
      'OPENMERGELENS_E2E_PR',
    );
    const username = environment.OPENMERGELENS_E2E_USERNAME.trim();
    const reviewFocusCount = parseBoundedInteger(
      environment.OPENMERGELENS_E2E_REVIEW_FOCUS_COUNT,
      'OPENMERGELENS_E2E_REVIEW_FOCUS_COUNT',
      1,
      4,
      1,
    );
    const reviewTimeoutMs = parseBoundedInteger(
      environment.OPENMERGELENS_E2E_REVIEW_TIMEOUT_MS,
      'OPENMERGELENS_E2E_REVIEW_TIMEOUT_MS',
      60_000,
      3_600_000,
      720_000,
    );

    return {
      mode,
      host,
      repository,
      number,
      username,
      reviewerCommand: environment.OPENMERGELENS_E2E_REVIEWER_COMMAND.trim(),
      reviewFocusCount,
      reviewTimeoutMs,
      keepHome: environment.OPENMERGELENS_E2E_KEEP_HOME === '1',
    };
  } catch (error) {
    return { error: error.message };
  }
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

function runPoll({ home, mode, timeoutMs }) {
  const args = ['bin/poll.mjs'];
  if (mode === 'dry-run') args.push('--dry-run');
  const timeout = Math.min(
    3_600_000,
    Math.max(120_000, timeoutMs * 6 + 60_000),
  );

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
  test('runs a real GitHub-backed OpenMergeLens review', async (t) => {
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

    const reviewerCommand = validateReviewerCommandContract(
      environment.reviewerCommand,
    );
    await saveConfig(path.join(home, 'config.json'), {
      configVersion: 5,
      githubAccounts: [{
        ...account,
        repositories: [environment.repository],
      }],
      reviewerCommand,
      aiProcessingConsent: createAiProcessingConsent(
        reviewerCommand,
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
      timeoutMs: environment.reviewTimeoutMs,
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
  });
}
