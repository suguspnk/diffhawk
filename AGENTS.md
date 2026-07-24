# diffhawk

Local, agent-agnostic poller that auto-reviews GitHub PRs whenever you're the
requested reviewer. Runs on your own machine on a schedule (cron / launchd /
Windows Task Scheduler) — no GitHub App, no webhook, no server. It shells out
to `gh` to find PRs and to a reviewer CLI of your choice (Claude Code, Codex,
or any other command) to generate the review, then posts it back as an
inline, severity-tagged GitHub review.

Setup and usage: [README.md](README.md). Full design rationale and history:
[PRD.md](PRD.md).

## Layout

```
bin/init.mjs              interactive setup wizard (repo picker, reviewer CLI detect, scheduling)
bin/poll.mjs              one-shot poll entrypoint (--dry-run supported)
lib/github.mjs            gh CLI wrappers: search, pr view, pr diff, post review
lib/state.mjs             read/write state.json (per-PR last-reviewed SHA)
lib/reviewer-adapter.mjs  abstraction over the configured reviewer command
lib/agent-detect.mjs      detects Claude Code / Codex on PATH + auth status
lib/scheduler.mjs         cron/launchd/Task Scheduler installers
docs/review-prompt.default.md template new per-repo review prompts are seeded from (committed)
docs/review-prompts/*.md      one review prompt per watched repo, sent to the reviewer CLI as-is + placeholders filled in (gitignored)
docs/learnings.md             optional, gitignored — durable corrections fed into prompts
```

`config.json`, `state.json`, and `docs/review-prompts/*.md` are gitignored
(local, machine-specific — the latter is seeded per repo by `init` from
`docs/review-prompt.default.md`, and re-running `init` never overwrites an
existing one). `config.example.json` is the config template.

`lib/reviewer-adapter.mjs`'s `buildPrompt` fills a repo's review-prompt
template's `{{pr_title}}`/`{{pr_number}}`/`{{pr_body}}`/`{{diff}}`/
`{{learnings_section}}` placeholders and always appends a fixed JSON
output-format instruction afterward — that instruction is never part of
the editable template, since `parseFindings` depends on it structurally.

## Key constraints (from the design spec — see PRD.md for the "why")

- No `.github/workflows/*.yml`, no webhooks, no tunnels. Pure client-side
  polling via `gh` CLI.
- State is keyed by `OWNER/REPO#N` → last-reviewed head SHA, not a seen/unseen
  boolean. A PR with new commits since its last review must be re-reviewed.
- The reviewer backend (`reviewerCommand`) must stay swappable via config —
  never hardcode a specific CLI invocation (e.g. `claude -p`) directly in the
  polling logic.
- If the reviewer CLI fails or returns nothing, skip posting and leave state
  untouched so the next poll retries. Never post a broken or empty review.
- Findings must anchor to a real diff line before being posted inline;
  anything that can't be anchored goes into the summary text instead of being
  silently dropped.
- Posting PR reviews from this bot is pre-approved by the user for this
  specific flow only — that approval doesn't extend to other PR-commenting
  contexts.

## Running it

```bash
node bin/poll.mjs --dry-run   # search, diff, prompt, invoke reviewer — no posting
node bin/poll.mjs             # posts real GitHub reviews, updates state.json
```

Failures are logged to `poll.log` in the repo root.
