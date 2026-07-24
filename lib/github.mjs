import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// All calls use execFile (never a shell), so PR titles/bodies/diffs can never
// be interpreted as shell syntax regardless of their content.
async function gh(args, options = {}) {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      maxBuffer: 1024 * 1024 * 64,
      ...options,
    });
    return stdout;
  } catch (err) {
    const detail = err.stderr || err.message;
    throw new Error(`gh ${args.join(' ')} failed: ${detail}`);
  }
}

export async function checkAuth() {
  try {
    await execFileAsync('gh', ['auth', 'status']);
    return true;
  } catch {
    return false;
  }
}

export async function currentUsername() {
  const out = await gh(['api', 'user', '--jq', '.login']);
  return out.trim();
}

// `gh repo list` (no owner arg) only returns repos owned by the current
// user's own account — it silently excludes repos owned by orgs or other
// users where the user is merely a collaborator/org member. Using
// GET /user/repos with an explicit affiliation instead covers all three,
// paginated since accounts with many repos (1000+) exceed one page.
export async function listAccessibleRepos() {
  const out = await gh([
    'api', '--paginate', '--method', 'GET', 'user/repos',
    '-f', 'affiliation=owner,collaborator,organization_member',
    '-f', 'per_page=100',
    '--jq', '.[] | {nameWithOwner: .full_name, isPrivate: .private}',
  ]);
  // --paginate with --jq emits one JSON object per line per page, not a
  // single JSON array — parse newline-delimited objects instead of one blob.
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Returns { repo, number } pairs (not bare numbers) so global-scope search
// results — which span multiple repos — carry enough info for later steps
// (pr view, diff, post review) without a second lookup.
export async function searchReviewRequestedPRs({ username, repo, global = false }) {
  const query = global
    ? `is:pr is:open review-requested:${username}`
    : `is:pr is:open review-requested:${username} repo:${repo}`;
  // --method GET is required: gh api defaults `-f` params to a POST body,
  // which 404s against /search/issues (a GET-only endpoint).
  const out = await gh([
    'api', '--method', 'GET', '/search/issues', '-f', `q=${query}`,
    '--jq', '.items[] | .repository_url + "|" + (.number | tostring)',
  ]);
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

export async function getPullRequest({ repo, number }) {
  const out = await gh([
    'pr', 'view', String(number),
    '--repo', repo,
    '--json', 'headRefOid,number,title,url,body,baseRefName,headRefName',
  ]);
  return JSON.parse(out);
}

export async function getPullRequestDiff({ repo, number }) {
  return gh(['pr', 'diff', String(number), '--repo', repo]);
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
export async function postReview({ repo, number, commitId, body, comments, diff, event = 'COMMENT' }) {
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
      unanchorable.map((c) => `- \`${c.path}:${c.line}\` ${formatComment(c)}`).join('\n')
    : '';

  const payload = {
    commit_id: commitId,
    event,
    body: body + extraBody,
    comments: anchorable.map((c) => ({
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      body: formatComment(c),
    })),
  };

  try {
    await gh(
      ['api', '--method', 'POST', `/repos/${repo}/pulls/${number}/reviews`, '--input', '-'],
      { input: JSON.stringify(payload) },
    );
  } catch (err) {
    // Last-resort fallback: fold every comment into the body and retry once,
    // so a single unexpected rejection doesn't lose the whole review.
    const fallbackBody = body +
      '\n\n---\n**All findings (inline comments rejected by GitHub):**\n' +
      comments.map((c) => `- \`${c.path}:${c.line}\` ${formatComment(c)}`).join('\n');
    await gh(
      ['api', '--method', 'POST', `/repos/${repo}/pulls/${number}/reviews`, '--input', '-'],
      { input: JSON.stringify({ commit_id: commitId, event, body: fallbackBody, comments: [] }) },
    );
  }
}
