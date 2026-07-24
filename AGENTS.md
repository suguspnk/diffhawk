# openrevuwer

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
bin/openrevuwer.mjs       published CLI entrypoint: dispatches to init.mjs or poll.mjs
bin/init.mjs              interactive setup wizard (repo picker, reviewer CLI detect, scheduling)
bin/poll.mjs              one-shot poll entrypoint (--dry-run supported)
lib/paths.mjs             resolves the per-user state directory (~/.openrevuwer, or $OPENREVUWER_HOME)
lib/github.mjs            gh CLI wrappers: search, pr view, pr diff, post review
lib/state.mjs             read/write state.json (per-PR last-reviewed SHA)
lib/reviewer-adapter.mjs  abstraction over the configured reviewer command
lib/agent-detect.mjs      detects Claude Code / Codex on PATH + auth status
lib/scheduler.mjs         cron/launchd/Task Scheduler installers
docs/checklist.md         bundled default review checklist injected into every prompt
```

All per-user state — `config.json`, `state.json`, `poll.log`, and the
editable `docs/checklist.md` / `docs/learnings.md` — lives under
`~/.openrevuwer/` (override with `OPENREVUWER_HOME`), not in this repo. See
`lib/paths.mjs`. `config.example.json` here is just the template `init`
copies from on first run.

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
openrevuwer --dry-run   # search, diff, prompt, invoke reviewer — no posting
openrevuwer             # posts real GitHub reviews, updates ~/.openrevuwer/state.json
openrevuwer init        # setup wizard
```

When working in this repo directly (not the published package), the
equivalent is `node bin/poll.mjs --dry-run` / `node bin/poll.mjs` /
`node bin/init.mjs` — same behavior, same `~/.openrevuwer` state directory.

Failures are logged to `~/.openrevuwer/poll.log`.
