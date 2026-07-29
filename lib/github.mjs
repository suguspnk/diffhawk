import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { authEnvironment } from './github-auth.mjs';
import {
  MAX_GH_OUTPUT_BYTES,
  MAX_GITHUB_REVIEW_BODY_CHARS,
  MAX_REVIEW_COMMENT_CHARS,
  MAX_REVIEW_FINDINGS,
  MAX_REVIEW_PATH_CHARS,
  MAX_REVIEW_SUMMARY_CHARS,
  REVIEWER_HARD_KILL_GRACE_MS,
} from './security-limits.mjs';
import {
  terminateProcessTree,
} from './process-launch.mjs';
import {
  isGitHubRateLimitError,
} from './github-mutation-queue.mjs';

const GH_TIMEOUT_MS = 60_000;

function httpStatusFromDiagnostic(diagnostic) {
  const match = String(diagnostic || '').match(/\bHTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})\b/i);
  return match ? Number(match[1]) : undefined;
}

export function retryMetadataFromDiagnostic(diagnostic) {
  const retryAfter = String(diagnostic || '').match(
    /^retry-after:\s*(\d+|[^\r\n]+)$/im,
  )?.[1]?.trim();
  const resetAt = String(diagnostic || '').match(
    /^x-ratelimit-reset:\s*(\d+)$/im,
  )?.[1];
  let retryAfterMs;
  if (/^\d+$/.test(retryAfter || '')) {
    retryAfterMs = Number(retryAfter) * 1_000;
  } else if (retryAfter) {
    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) {
      retryAfterMs = Math.max(0, retryDate - Date.now());
    }
  }
  return {
    retryAfterMs,
    rateLimitResetAtMs: resetAt ? Number(resetAt) * 1_000 : undefined,
  };
}

// Deliberately not execFile's `input` option: on Node 22 / macOS (confirmed
// with a minimal `cat`-only repro, no gh/network involved) execFile+input
// reproducibly hangs forever instead of resolving once the child exits —
// the write appears to never signal completion back to the wait/exit
// machinery. Piping via spawn() + manual stdin.write()/stdin.end() (the
// same pattern already used in reviewer-adapter.mjs's invokeReviewer)
// sidesteps it entirely and returns immediately once the child closes.
function ghSpawn(args, { input, timeoutMs = GH_TIMEOUT_MS, auth } = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn('gh', args, {
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: authEnvironment(auth),
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdinError;
    let terminalError;
    let settled = false;
    let hardKillTimer;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardKillTimer);
      callback();
    };
    const terminateWith = (error) => {
      if (terminalError || settled) return;
      terminalError = error;
      void terminateProcessTree(child, {
        platform: process.platform,
        force: false,
      });
      hardKillTimer = setTimeout(() => {
        void terminateProcessTree(child, {
          platform: process.platform,
          force: true,
        }).finally(() => settle(() => reject(terminalError)));
      }, REVIEWER_HARD_KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      terminateWith(Object.assign(
        new Error(`gh ${args.join(' ')} timed out after ${timeoutMs}ms`),
        { code: 'ETIMEDOUT' },
      ));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (terminalError) return;
      stdoutBytes += Buffer.byteLength(d);
      if (stdoutBytes > MAX_GH_OUTPUT_BYTES) {
        stdout = '';
        terminateWith(Object.assign(
          new Error(`gh stdout exceeded ${MAX_GH_OUTPUT_BYTES} bytes`),
          { code: 'EOVERFLOW' },
        ));
        return;
      }
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (terminalError) return;
      stderrBytes += Buffer.byteLength(d);
      if (stderrBytes > MAX_GH_OUTPUT_BYTES) {
        stderr = '';
        terminateWith(Object.assign(
          new Error(`gh stderr exceeded ${MAX_GH_OUTPUT_BYTES} bytes`),
          { code: 'EOVERFLOW' },
        ));
        return;
      }
      stderr += d;
    });
    child.stdin.on?.('error', (err) => {
      stdinError = err;
    });
    child.on('error', (err) => {
      settle(() => reject(err));
    });
    child.on('close', (code) => {
      if (terminalError) {
        settle(() => reject(terminalError));
      } else if (code !== 0) {
        const diagnostic = `${stdout}\n${stderr}`;
        settle(() => reject(Object.assign(
          new Error(stderr || `gh ${args.join(' ')} exited ${code}`),
          {
            exitCode: code,
            stdout,
            stderr,
            status: httpStatusFromDiagnostic(diagnostic),
            ...retryMetadataFromDiagnostic(diagnostic),
          },
        )));
      } else if (stdinError) {
        settle(() => reject(
          new Error(`failed to send input to gh: ${stdinError.message}`),
        ));
      } else {
        settle(() => resolve(stdout));
      }
    });

    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

// All calls use spawn/execFile with an argv array (never a shell), so PR
// titles/bodies/diffs can never be interpreted as shell syntax regardless
// of their content.
async function gh(args, options = {}) {
  try {
    return await ghSpawn(args, options);
  } catch (err) {
    const detail = err.stderr || err.message;
    throw Object.assign(
      new Error(`gh ${args.join(' ')} failed: ${detail}`, { cause: err }),
      {
        code: err.code,
        exitCode: err.exitCode,
        status: err.status,
        stdout: err.stdout,
        stderr: err.stderr,
        retryAfterMs: err.retryAfterMs,
        rateLimitResetAtMs: err.rateLimitResetAtMs,
      },
    );
  }
}

export async function currentUsername({ auth } = {}) {
  const out = await gh(['api', 'user', '--jq', '.login'], { auth });
  return out.trim();
}

// `gh repo list` (no owner arg) only returns repos owned by the current
// user's own account — it silently excludes repos owned by orgs or other
// users where the user is merely a collaborator/org member. Using
// GET /user/repos with an explicit affiliation instead covers all three,
// paginated since accounts with many repos (1000+) exceed one page.
export async function listAccessibleRepos({ auth } = {}) {
  const out = await gh([
    'api', '--paginate', '--method', 'GET', 'user/repos',
    '-f', 'affiliation=owner,collaborator,organization_member',
    '-f', 'per_page=100',
    '--jq', '.[] | {nameWithOwner: .full_name, isPrivate: .private}',
  ], { auth });
  // --paginate with --jq emits one JSON object per line per page, not a
  // single JSON array — parse newline-delimited objects instead of one blob.
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Returns { repo, number } pairs so every result retains the canonical
// repository slug returned by GitHub for later metadata/diff/post calls.
export async function searchReviewRequestedPRs({ username, repo, auth }) {
  const query = `is:pr is:open review-requested:${username} repo:${repo}`;
  // --method GET is required: gh api defaults `-f` params to a POST body,
  // which 404s against /search/issues (a GET-only endpoint).
  // --paginate so a user with 100+ open PRs awaiting their review across
  // watched repos doesn't silently lose results past the first page (same
  // reasoning as listAccessibleRepos below).
  const out = await gh([
    'api', '--paginate', '--method', 'GET', '/search/issues',
    '-f', `q=${query}`, '-f', 'per_page=100',
    '--jq', '.items[] | .repository_url + "|" + (.number | tostring)',
  ], { auth });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [repoUrl, numberStr] = line.split('|');
      // repository_url is like https://api.github.com/repos/OWNER/REPO
      const repoSlug = repoUrl.split('/repos/')[1];
      return { repo: repoSlug, number: Number(numberStr) };
    });
}

export async function getPullRequest({ repo, number, auth }) {
  const out = await gh([
    'pr', 'view', String(number),
    '--repo', repo,
    '--json', 'headRefOid,number,title,url,body,baseRefName,headRefName,state',
  ], { auth });
  return JSON.parse(out);
}

export async function getPullRequestDiff({ repo, number, auth }) {
  return gh(['pr', 'diff', String(number), '--repo', repo], { auth });
}

// Parses a unified diff into a set of "path:line" strings that are actually
// addressable as RIGHT-side review comments (i.e. added/context lines within
// a hunk). GitHub 422s a whole review if any comment's line isn't part of
// the diff, so findings must be checked against this before being sent as
// inline comments rather than discovered via a failed API call.
export function diffAnchors(diffText) {
  const anchors = new Set();
  let currentPath = null;
  let rightLine = null;

  for (const line of diffText.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentPath = fileMatch[1];
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      rightLine = Number(hunkMatch[1]);
      continue;
    }
    if (rightLine === null || currentPath === null) continue;

    if (line.startsWith('+')) {
      anchors.add(`${currentPath}:${rightLine}`);
      rightLine += 1;
    } else if (line.startsWith(' ')) {
      anchors.add(`${currentPath}:${rightLine}`);
      rightLine += 1;
    } else if (line.startsWith('-')) {
      // Removed line — doesn't advance the right-side line counter.
    }
  }

  return anchors;
}

function formatComment(c) {
  return `**[${c.severity}]** ${c.comment}`;
}

function formatAttribution(auth) {
  const username = auth?.username?.trim();
  if (!username) {
    throw new Error('review attribution requires the authenticated reviewer username');
  }
  return `🤖 **AI-generated review:** OpenMergeLens generated this review on behalf of @${username}. Verify findings before acting.`;
}

function formatFindingLocation(c) {
  const safePath = c.path
    .replace(/[\r\n\u0000]/g, '\uFFFD')
    .replaceAll('`', '\\`');
  return `\`${safePath}:${c.line}\``;
}

function validateReviewForPosting(body, comments) {
  if (typeof body !== 'string' || body.length > MAX_REVIEW_SUMMARY_CHARS) {
    throw new Error(`review summary exceeds ${MAX_REVIEW_SUMMARY_CHARS} characters`);
  }
  if (!Array.isArray(comments) || comments.length > MAX_REVIEW_FINDINGS) {
    throw new Error(`review exceeds ${MAX_REVIEW_FINDINGS} findings`);
  }
  for (const comment of comments) {
    if (
      !comment ||
      typeof comment.path !== 'string' ||
      !comment.path ||
      comment.path.length > MAX_REVIEW_PATH_CHARS ||
      /[\r\n\u0000]/.test(comment.path) ||
      !Number.isSafeInteger(comment.line) ||
      comment.line < 1 ||
      !['critical', 'major', 'nit'].includes(comment.severity) ||
      typeof comment.comment !== 'string' ||
      !comment.comment ||
      comment.comment.length > MAX_REVIEW_COMMENT_CHARS
    ) {
      throw new Error('review contains an invalid or unsafe finding');
    }
  }
}

export function createReviewMarker({ account, repo, number, commitId }) {
  const identity = JSON.stringify([
    account.hostname.toLowerCase(),
    account.username.toLowerCase(),
    repo.toLowerCase(),
    Number(number),
    commitId,
  ]);
  const digest = createHash('sha256').update(identity).digest('hex');
  return `<!-- openmergelens-review:${digest} -->`;
}

function parseJsonLines(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function reviewAlreadyPosted({
  repo,
  number,
  commitId,
  marker,
  auth,
  request = gh,
}) {
  const expectedReviewer = auth?.username?.trim().toLowerCase();
  if (!expectedReviewer) {
    throw new Error('review reconciliation requires the authenticated reviewer username');
  }
  const out = await request([
    'api',
    '--paginate',
    '--method',
    'GET',
    `/repos/${repo}/pulls/${number}/reviews`,
    '-f',
    'per_page=100',
    '--jq',
    '.[] | {body, commit_id, state, user_login: .user.login}',
  ], { auth });
  return parseJsonLines(out).some(
    (review) =>
      review.state !== 'PENDING' &&
      review.commit_id === commitId &&
      review.user_login?.toLowerCase() === expectedReviewer &&
      review.body?.includes(marker),
  );
}

async function reconcileSubmittedReview(options, originalError) {
  try {
    return await reviewAlreadyPosted(options);
  } catch (reconciliationError) {
    throw new Error(
      `${originalError.message}; could not reconcile the review: ${reconciliationError.message}`,
      { cause: originalError },
    );
  }
}

// Uses `gh api` (not `gh pr review`) because the CLI subcommand has no way to
// attach per-line comments — only the REST API's `comments[]` array does.
//
// Findings are split into anchorable (path:line present in the diff) and
// unanchorable before ever calling the API, since GitHub rejects the entire
// review if a single comment's line isn't part of the diff — one bad/
// hallucinated line number must not lose the whole review. Unanchorable
// findings are folded into the body instead of dropped. As a last-resort
// safety net (e.g. a line technically in the diff but rejected for some
// other reason), a 422 on the full request is retried once with every
// comment demoted into the body, so posting only fails if that also fails.
export async function postReview({
  repo,
  number,
  commitId,
  body,
  comments,
  diff,
  marker,
  event = 'COMMENT',
  auth,
  request = gh,
  scheduleMutation,
}) {
  if (!marker) throw new Error('review marker is required');
  if (typeof scheduleMutation !== 'function') {
    throw new Error('review posting requires a GitHub mutation scheduler');
  }
  validateReviewForPosting(body, comments);

  const anchors = diffAnchors(diff);
  const anchorable = [];
  const unanchorable = [];

  for (const c of comments) {
    if (anchors.has(`${c.path}:${c.line}`)) {
      anchorable.push(c);
    } else {
      unanchorable.push(c);
    }
  }

  const extraBody = unanchorable.length
    ? '\n\n---\n**Additional findings (could not anchor to a diff line):**\n' +
      unanchorable.map((c) => `- ${formatFindingLocation(c)} ${formatComment(c)}`).join('\n')
    : '';
  const attribution = formatAttribution(auth);
  const reviewBody = `${body}${extraBody}\n\n---\n${attribution}\n\n${marker}`;
  if (reviewBody.length > MAX_GITHUB_REVIEW_BODY_CHARS) {
    throw new Error(
      `review body exceeds ${MAX_GITHUB_REVIEW_BODY_CHARS} characters`,
    );
  }

  const payload = {
    commit_id: commitId,
    event,
    body: reviewBody,
    comments: anchorable.map((c) => ({
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      body: formatComment(c),
    })),
  };

  try {
    await scheduleMutation(
      () => request(
        [
          'api', '--include', '--method', 'POST',
          `/repos/${repo}/pulls/${number}/reviews`, '--input', '-',
        ],
        { input: JSON.stringify(payload), auth },
      ),
    );
  } catch (err) {
    // A rate-limited mutation is definitively rejected. Do not issue even a
    // reconciliation GET while GitHub has told this integration to pause.
    if (isGitHubRateLimitError(err)) throw err;
    const reconciliationOptions = {
      repo,
      number,
      commitId,
      marker,
      auth,
      request,
    };
    if (await reconcileSubmittedReview(reconciliationOptions, err)) return;
    if (err.status !== 422 || anchorable.length === 0) throw err;

    // Last-resort fallback: fold every comment into the body and retry once,
    // so a single unexpected rejection doesn't lose the whole review.
    const fallbackBody = body +
      '\n\n---\n**All findings (inline comments rejected by GitHub):**\n' +
      comments.map((c) => `- ${formatFindingLocation(c)} ${formatComment(c)}`).join('\n') +
      `\n\n---\n${attribution}\n\n${marker}`;
    if (fallbackBody.length > MAX_GITHUB_REVIEW_BODY_CHARS) {
      throw new Error(
        `fallback review body exceeds ${MAX_GITHUB_REVIEW_BODY_CHARS} characters`,
      );
    }
    try {
      await scheduleMutation(
        () => request(
          [
            'api', '--include', '--method', 'POST',
            `/repos/${repo}/pulls/${number}/reviews`, '--input', '-',
          ],
          {
            input: JSON.stringify({
              commit_id: commitId,
              event,
              body: fallbackBody,
              comments: [],
            }),
            auth,
          },
        ),
      );
    } catch (fallbackError) {
      if (isGitHubRateLimitError(fallbackError)) throw fallbackError;
      if (await reconcileSubmittedReview(reconciliationOptions, fallbackError)) return;
      throw fallbackError;
    }
  }
}
