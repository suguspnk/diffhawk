# PR Review Bot — Handoff Spec

Local, agent-agnostic poller that auto-reviews GitHub PRs whenever you (antonio)
are the requested reviewer — whether that's set at PR creation or added later —
and re-reviews when new commits land after the last review. Posts results as a
PR comment automatically, no per-run approval needed.

Repo: `~/Symph/projects/pr-review-bot` (git initialized, no remote — keep it
local only unless explicitly decided otherwise later).

This doc is the full spec. Nothing has been implemented yet — pick this up in
a fresh session with: "implement the PR review bot per HANDOFF.md".

## Why this exists (context from design conversation)

- Claude Code / `claude-code-action` has no built-in "watch GitHub, trigger
  local review on reviewer-assignment" feature. GitHub Actions triggers always
  run on Actions runners (GitHub-hosted or self-hosted); this project
  deliberately avoids committing any `.github/workflows/*.yml` — no workflow
  file, no webhook, no tunnel. Pure client-side polling using `gh` CLI.
- Requirements gathered from user:
  1. Trigger scope: PR opened with me as requested reviewer, OR added as
     reviewer to an already-open PR. GitHub's `review_requested` event/search
     qualifier covers both — but we're polling, not subscribing to webhooks,
     so we detect this via periodic search, not the event itself.
  2. "Seen ≠ done" — must not just track "have I looked at this PR" but
     detect **new commits since the last review** and re-trigger. So state is
     keyed by PR + last-reviewed commit SHA, not a boolean seen/unseen flag.
  3. Needs a real review prompt, not "review this PR" — reuse
     `socialpostai-v2/docs/CODE_QUALITY_GUIDELINES.md` as the checklist for
     that repo; make the prompt/checklist source configurable per-repo since
     this bot may eventually watch repos beyond socialpostai-v2.
  4. Output: post directly as a `gh pr comment` — auto-approved by the user
     for this specific automated flow, no confirmation prompt needed each run.
     (This approval is scoped to this bot's own posting behavior only — not a
     general standing permission for PR comments in other contexts.)
  5. Agent-agnostic: don't hardcode a `claude` CLI invocation. The "reviewer
     backend" should be a swappable command/adapter so any CLI capable of
     taking a prompt + diff and returning review text can be plugged in.
  6. Run mode: no preference given — default to **one-shot script + externally
     scheduled** (cron/launchd/`/loop`), since that's simplest to test and
     most flexible. A built-in loop mode can be added later if wanted.

## Architecture

```
pr-review-bot/
├── HANDOFF.md              (this file)
├── config.json             (repos to watch, reviewer username, checklist paths)
├── state.json              (gitignored — per-PR last-reviewed SHA, local only)
├── bin/
│   └── poll.sh              (or poll.mjs/poll.py — one-shot entrypoint)
├── lib/
│   ├── github.sh            (gh CLI wrappers: search, pr view, pr diff, pr comment)
│   ├── state.sh             (read/write state.json)
│   └── reviewer-adapter.sh  (abstraction over the actual review-generating command)
└── .gitignore               (state.json, .env, any local secrets)
```

Language choice not yet decided — bash (thin `gh` wrapper) or a small
Node/Python script are all reasonable; pick whichever is more comfortable to
extend later (e.g. Node if config/state grow more complex).

## Core logic (one poll cycle)

1. **Discover candidate PRs**, per configured repo (or across all repos via
   search):
   ```bash
   gh api /search/issues -f q="is:pr is:open review-requested:antonio repo:OWNER/REPO" --jq '.items[].number'
   ```
   Run once per repo in `config.json`, or omit `repo:` to search globally if
   you want cross-repo coverage from one config entry.

2. **For each candidate PR**, get the current head commit SHA:
   ```bash
   gh pr view <N> --repo OWNER/REPO --json headRefOid,number,title,url
   ```

3. **Compare against state.json**:
   - Key: `OWNER/REPO#N`
   - If key absent → new PR, needs review.
   - If key present and stored SHA != current `headRefOid` → new commits since
     last review, needs re-review.
   - If key present and SHA matches → skip, already reviewed this exact head.

4. **For PRs needing review**, build the review prompt:
   - Fetch diff: `gh pr diff <N> --repo OWNER/REPO`
   - Fetch PR metadata (title, description, base/head branch) via `gh pr view`
   - Load repo-specific checklist doc if configured (e.g.
     `socialpostai-v2/docs/CODE_QUALITY_GUIDELINES.md`) and inline it into the
     prompt as review criteria.
   - Compose a prompt roughly like:
     ```
     Review this pull request diff against the checklist below. Report
     concrete, high-confidence issues only (bugs, security, correctness,
     violations of established repo conventions). Cite file:line. Be direct,
     no preamble.

     ## Checklist
     <contents of CODE_QUALITY_GUIDELINES.md or repo-configured doc>

     ## PR: <title> (#<N>)
     <description>

     ## Diff
     <diff>
     ```

5. **Invoke the reviewer adapter** (agent-agnostic — see below) with that
   prompt, capture its text output.

6. **Post the review**:
   ```bash
   gh pr comment <N> --repo OWNER/REPO --body-file <tmpfile>
   ```
   No confirmation gate — auto-approved per user's decision for this flow.

7. **Update state.json** with the new `headRefOid` for that PR key, so the
   same commit doesn't get re-reviewed next poll.

## Agent-agnostic reviewer adapter

Don't hardcode `claude -p ...`. Instead, define a config field like:

```json
{
  "reviewerCommand": "claude -p --output-format text",
  "reviewerInputMode": "stdin"
}
```

The adapter script pipes the composed prompt to `reviewerCommand` via stdin (or
substitutes a `{prompt_file}` placeholder if the backend needs a file path
instead of stdin) and captures stdout as the review text. This way, swapping
to a different CLI (another agent runtime, a different model wrapper, a local
LLM harness) is a one-line config change, not a code change.

Suggested default for `reviewerCommand`: `claude -p` reading the prompt from
stdin, since that matches how the user already works — but keep it swappable.

## Config shape (draft)

```json
{
  "githubUsername": "antonio",
  "pollTargets": [
    {
      "repo": "OWNER/socialpostai-v2",
      "checklistPath": "/absolute/path/to/socialpostai-v2/docs/CODE_QUALITY_GUIDELINES.md"
    }
  ],
  "reviewerCommand": "claude -p",
  "stateFile": "./state.json"
}
```

Fill in the actual `OWNER/repo` slug for socialpostai-v2 when implementing
(check `git remote -v` in that repo, or ask the user — don't guess).

## State file shape (gitignored, local only)

```json
{
  "OWNER/socialpostai-v2#123": {
    "lastReviewedSha": "abc123...",
    "lastReviewedAt": "2026-07-24T18:00:00Z"
  }
}
```

## Scheduling (left to the user / next session)

Default recommendation: one-shot script (`bin/poll.sh`), scheduled externally.
Options to offer when implementing:
- `cron` entry running `poll.sh` every N minutes
- `launchd` plist (more idiomatic on macOS, survives reboots better than cron)
- Claude Code's `/loop` skill wrapping a shell invocation, if the user wants
  to drive it from inside a Claude Code session instead of OS-level scheduling

## Auth prerequisites

- `gh auth status` must show an authenticated account with `repo` scope
  (needed for `pr comment`, `pr view`, `pr diff` on private repos).
- Whatever `reviewerCommand` is configured must have its own auth already
  set up independently (e.g. `claude` CLI already logged in).

## Open items for the next session

1. Pick implementation language (bash vs Node vs Python).
2. Confirm the actual `OWNER/repo` slug(s) to watch.
3. Decide whether to search per-repo or use one global
   `review-requested:antonio` search across all repos the user has access to.
4. Decide error handling: what happens if `reviewerCommand` fails or returns
   empty — should it skip posting (recommended) and leave state unchanged so
   it retries next poll?
5. Decide whether reviews should be posted as a single PR comment per poll,
   or use `gh pr review` (formal review, e.g. COMMENT/APPROVE/REQUEST_CHANGES
   event type) instead of a plain issue-style comment — spec above defaults
   to plain comment via `gh pr comment` since that's simplest, but a real
   review object may be preferable for visibility in the PR's review list.
6. Set up scheduling (cron/launchd/`/loop`) once the script is working.
