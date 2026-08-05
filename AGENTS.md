# OpenMergeLens

A local CLI that automates AI code reviews for GitHub pull requests using
Codex, Claude Code, or any compatible MCP-enabled reviewer CLI. OpenMergeLens
runs on the user's machine on a schedule: no GitHub App, webhook, or server.
It uses `gh` to find requested reviews and the configured reviewer CLI to
generate inline, severity-tagged GitHub reviews.

Setup and usage: [README.md](README.md). Full design rationale and history:
[PRD.md](PRD.md). Coding standards for this repo:
[docs/CODE_QUALITY_GUIDELINES.md](docs/CODE_QUALITY_GUIDELINES.md) (project
rules) and [docs/tech-stack-standards.md](docs/tech-stack-standards.md)
(external library/tool best practices).

## Layout

```
bin/openmergelens.mjs       published CLI entrypoint: dispatches to init.mjs or poll.mjs
bin/init.mjs              interactive setup wizard (repo picker, reviewer CLI detect, scheduling)
bin/poll.mjs              one-shot poll entrypoint (--dry-run supported)
bin/scheduled.mjs         restores the setup-time PATH/home before scheduled polling
lib/dispatch.mjs          parses CLI arguments and dispatches init or poll commands
lib/paths.mjs             resolves the per-user state directory (~/.openmergelens, or $OPENMERGELENS_HOME)
lib/github.mjs            gh CLI wrappers: search, pr view, pr diff, post review
lib/github-auth.mjs       resolves + scopes GitHub credentials (multi-account aware)
lib/state.mjs             read/write state.json (per-PR last-reviewed SHA)
lib/desktop-notifications.mjs  formats + delivers native macOS/Windows/Linux notifications
lib/reviewer-command-defaults.mjs  safe known-backend commands + exact legacy upgrades
lib/reviewer-adapter.mjs  abstraction over the configured reviewer command + prompt templating
lib/review-prompts.mjs    seeds/locates each watched repo's review-prompt file under the user's OpenMergeLens home
lib/agent-detect.mjs      detects Claude Code / Codex on PATH + auth status
lib/process-launch.mjs    resolves executables + safely launches Windows .cmd/.bat shims
lib/scheduler.mjs         cron/launchd/Task Scheduler installers
test/                     node:test suite (`npm test`)
docs/review-prompt.default.md  bundled template new per-repo review prompts are seeded from
docs/CODE_QUALITY_GUIDELINES.md  project-specific review and implementation guidance
docs/learnings.md         optional, gitignored: durable corrections fed into prompts
```

All per-user state, including `config.json`, `state.json`, `poll.log`, the
editable `docs/review-prompts/<owner>/<repo>.md` files, and `docs/learnings.md`,
lives under `~/.openmergelens/` (override with `OPENMERGELENS_HOME`), not in
this repo. See `lib/paths.mjs`. `config.example.json` here is just the
config template; `docs/review-prompt.default.md` is the review-prompt
template `init` seeds each repo's copy from on first use.

`lib/reviewer-adapter.mjs`'s `buildPrompt` fills a repo's review-prompt
template's `{{pr_title}}`/`{{pr_number}}`/`{{pr_body}}`/`{{diff}}`/
`{{learnings_section}}` placeholders and always appends a fixed JSON
output-format instruction afterward. That instruction is never part of the
editable template, since `parseFindings` depends on it structurally. A
template with no `{{diff}}` placeholder (e.g. an un-migrated pre-template
checklist file) is treated as legacy content and wrapped with the old fixed
framing instead, so it keeps producing a working prompt.

## Key constraints (from the design spec; see PRD.md for the "why")

- No `.github/workflows/*.yml`, no webhooks, no tunnels. Pure client-side
  polling via `gh` CLI.
- State is keyed by `HOST@USERNAME::OWNER/REPO#N` → last-reviewed head SHA, not
  a seen/unseen boolean. A PR with new commits since its last review can be
  re-reviewed only after the configured account is requested again in GitHub's
  **Reviewers** list; new commits alone are not a trigger.
- The reviewer backend (`reviewerCommand`) must stay swappable via config;
  never hardcode a specific CLI invocation (e.g. `claude -p`) directly in the
  polling logic.
- If the reviewer CLI fails or returns nothing, skip posting and leave state
  untouched so the next poll retries. Never post a broken or empty review.
- Findings must anchor to a real diff line before being posted inline;
  anything that can't be anchored goes into the summary text instead of being
  silently dropped.
- Posting PR reviews from this bot is pre-approved by the user for this
  specific flow only. That approval doesn't extend to other PR-commenting
  contexts.

## Running it

```bash
openmergelens --dry-run   # search, diff, prompt, invoke reviewer: no posting
openmergelens             # posts real GitHub reviews, updates ~/.openmergelens/state.json
openmergelens init        # setup wizard
```

When working in this repo directly (not the published package), the
equivalent is `node bin/poll.mjs --dry-run` / `node bin/poll.mjs` /
`node bin/init.mjs`: same behavior, same `~/.openmergelens` state directory.

Failures are logged to `~/.openmergelens/poll.log`.
