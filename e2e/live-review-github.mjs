import childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { normalizeRepository } from '../lib/config.mjs';
import { authEnvironment } from '../lib/github-auth.mjs';
import { MAX_GH_OUTPUT_BYTES } from '../lib/security-limits.mjs';

const GH_TIMEOUT_MS = 60_000;

function runGh(args, { auth, input, timeoutMs = GH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn('gh', args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: authEnvironment(auth),
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(() => reject(
        new Error(`gh ${args.join(' ')} timed out after ${timeoutMs}ms`),
      ));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes > MAX_GH_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        settle(() => reject(new Error('GitHub CLI output exceeded its safety limit')));
        return;
      }
      stdout += stdoutDecoder.write(buffer);
    });
    child.stderr.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.byteLength;
      if (stderrBytes > MAX_GH_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        settle(() => reject(new Error('GitHub CLI diagnostics exceeded its safety limit')));
        return;
      }
      stderr += stderrDecoder.write(buffer);
    });
    child.on('error', (error) => settle(() => reject(error)));
    child.stdin.on('error', (error) => settle(() => reject(error)));
    child.on('close', (code) => {
      if (settled) return;
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (code !== 0) {
        settle(() => reject(new Error(
          stderr.trim() || `gh ${args.join(' ')} exited with ${code}`,
        )));
        return;
      }
      settle(() => resolve(stdout));
    });

    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

function parseJson(output, description) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${description} returned invalid JSON: ${error.message}`);
  }
}

function parseJsonLines(output, description) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJson(line, description));
}

async function ghJson(args, { auth, input, description } = {}) {
  const output = await runGh(args, { auth, input });
  return parseJson(output, description || `gh ${args.join(' ')}`);
}

async function ghMutation(args, { auth, input } = {}) {
  await runGh(args, { auth, input });
}

function safeSuffix(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 50);
  return normalized || `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function safeBranch(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    !/^[A-Za-z0-9._/-]+$/u.test(value) ||
    value.includes('..') ||
    value.startsWith('/') ||
    value.endsWith('/')
  ) {
    throw new Error('GitHub returned an unsafe base branch name');
  }
  return value;
}

export const LIVE_REVIEW_FIXTURE_SOURCE = [
  "import { exec } from 'node:child_process';",
  '',
  'export function runDiagnosticCommand(userInput, callback) {',
  '  exec(`git status --short ${userInput}`, callback);',
  '}',
  '',
].join('\n');

export function inlineCommentExists(review, comments) {
  if (review?.id === undefined || !Array.isArray(comments)) return false;
  return comments.some((comment) =>
    comment?.pull_request_review_id !== undefined &&
    String(comment.pull_request_review_id) === String(review.id) &&
    typeof comment.path === 'string' &&
    comment.path.length > 0 &&
    Number.isSafeInteger(comment.line) &&
    comment.line > 0,
  );
}

export async function createDisposablePullRequest({
  repo,
  reviewerUsername,
  authorAuth,
  baseBranch,
  id,
}) {
  const repository = normalizeRepository(repo);
  const suffix = safeSuffix(id);
  const repositoryMetadata = await ghJson(
    ['api', `repos/${repository}`, '--jq', '{default_branch: .default_branch}'],
    { auth: authorAuth, description: 'repository metadata' },
  );
  const requestedBaseBranch = baseBranch || repositoryMetadata.default_branch;
  if (!requestedBaseBranch) throw new Error('GitHub repository has no default branch');
  const resolvedBaseBranch = safeBranch(requestedBaseBranch);

  const ref = await ghJson(
    ['api', `repos/${repository}/git/ref/heads/${resolvedBaseBranch}`],
    { auth: authorAuth, description: 'base branch metadata' },
  );
  const baseSha = ref.object?.sha;
  if (!baseSha) throw new Error('GitHub base branch response has no commit SHA');

  const branch = `openmergelens-e2e/${suffix}-${randomBytes(4).toString('hex')}`;
  const fixturePath = `e2e-fixtures/openmergelens-live-${suffix}.mjs`;
  const title = `[OpenMergeLens E2E] ${suffix}`;
  const body = [
    'This disposable pull request was created by the OpenMergeLens live review E2E.',
    '',
    'It intentionally contains a command-injection fixture. The reviewer must ' +
      'leave at least one inline finding on the changed code.',
    '',
    'Do not merge this pull request.',
  ].join('\n');
  let branchCreated = false;
  let pullRequest;

  try {
    // Mark the branch as potentially created before the request. If the
    // network fails after GitHub accepts the mutation, cleanup should still
    // attempt to remove the disposable ref.
    branchCreated = true;
    await ghMutation(
      ['api', '--method', 'POST', `repos/${repository}/git/refs`, '--input', '-'],
      {
        auth: authorAuth,
        input: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
      },
    );

    await ghMutation(
      ['api', '--method', 'PUT', `repos/${repository}/contents/${fixturePath}`, '--input', '-'],
      {
        auth: authorAuth,
        input: JSON.stringify({
          message: title,
          content: Buffer.from(LIVE_REVIEW_FIXTURE_SOURCE, 'utf8').toString('base64'),
          branch,
        }),
      },
    );

    pullRequest = await ghJson(
      ['api', '--method', 'POST', `repos/${repository}/pulls`, '--input', '-'],
      {
        auth: authorAuth,
        input: JSON.stringify({ title, body, head: branch, base: resolvedBaseBranch }),
        description: 'pull request creation',
      },
    );
    if (!Number.isSafeInteger(pullRequest.number) || !pullRequest.head?.sha) {
      throw new Error('GitHub pull request response is missing number or head SHA');
    }

    await ghMutation(
      [
        'api', '--method', 'POST',
        `repos/${repository}/pulls/${pullRequest.number}/requested_reviewers`,
        '--input', '-',
      ],
      {
        auth: authorAuth,
        input: JSON.stringify({ reviewers: [reviewerUsername] }),
      },
    );
  } catch (error) {
    const cleanupFailures = [];
    if (pullRequest?.number) {
      try {
        await closeDisposablePullRequest({
          repo: repository,
          number: pullRequest.number,
          branch,
          auth: authorAuth,
        });
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError.message);
      }
    } else if (branchCreated) {
      try {
        await ghMutation(
          ['api', '--method', 'DELETE', `repos/${repository}/git/refs/heads/${branch}`],
          { auth: authorAuth },
        );
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError.message);
      }
    }
    if (cleanupFailures.length > 0) {
      error.message += `; provisioning cleanup also failed: ${cleanupFailures.join('; ')}`;
    }
    throw error;
  }

  return {
    repo: repository,
    number: pullRequest.number,
    branch,
    fixturePath,
    url: pullRequest.html_url || pullRequest.url,
    headSha: pullRequest.head.sha,
    baseBranch: resolvedBaseBranch,
  };
}

export async function closeDisposablePullRequest({ repo, number, branch, auth }) {
  const repository = normalizeRepository(repo);
  const errors = [];
  try {
    await ghMutation(
      ['api', '--method', 'PATCH', `repos/${repository}/pulls/${number}`, '--input', '-'],
      { auth, input: JSON.stringify({ state: 'closed' }) },
    );
  } catch (error) {
    errors.push(`closing PR failed: ${error.message}`);
  }
  try {
    await ghMutation(
      ['api', '--method', 'DELETE', `repos/${repository}/git/refs/heads/${branch}`],
      { auth },
    );
  } catch (error) {
    errors.push(`deleting branch failed: ${error.message}`);
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
}

export async function listPullRequestReviews({ repo, number, auth }) {
  const repository = normalizeRepository(repo);
  const output = await runGh([
    'api', '--paginate', '--method', 'GET',
    `repos/${repository}/pulls/${number}/reviews`,
    '-f', 'per_page=100',
    '--jq', '.[] | {id, body, commit_id, state, user_login: .user.login}',
  ], { auth });
  return parseJsonLines(output, 'pull request reviews');
}

export async function listPullRequestReviewComments({ repo, number, auth }) {
  const repository = normalizeRepository(repo);
  const output = await runGh([
    'api', '--paginate', '--method', 'GET',
    `repos/${repository}/pulls/${number}/comments`,
    '-f', 'per_page=100',
    '--jq', '.[] | {id, path, line, body, pull_request_review_id, user_login: .user.login}',
  ], { auth });
  return parseJsonLines(output, 'pull request review comments');
}
