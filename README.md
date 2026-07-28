# openrevuwer

Local, agent-agnostic poller that auto-reviews GitHub PRs whenever you're the
requested reviewer. Runs on your own machine on a schedule (cron / launchd /
Windows Task Scheduler) — no GitHub App, no webhook, no server. It shells out
to `gh` to find PRs and to a reviewer CLI of your choice (Claude Code, Codex,
or any other command) to generate the review, then posts it back as an inline,
severity-tagged GitHub review.

Full design rationale lives in [PRD.md](./PRD.md). This doc is just
setup.

## Prerequisites

Before running anything, make sure you have:

1. **Node.js 18+**
   ```bash
   node --version
   ```
2. **GitHub CLI (`gh`), authenticated**
   ```bash
   gh auth status
   ```
   If this fails, run `gh auth login` first. Multiple authenticated accounts,
   including accounts on different GitHub hosts, can run together.
3. **A reviewer CLI**, already logged in on its own — pick one:
   - [Claude Code](https://claude.com/claude-code): `claude /login`
   - [Codex CLI](https://github.com/openai/codex): `codex login`
   - Anything else that can read a prompt from stdin and print text/JSON to
     stdout.

## Install

```bash
npm install -g openrevuwer
```

Or skip the install and run it on demand with `npx`:

```bash
npx openrevuwer init
```

Config, poll state, logs, and your editable per-repo review prompts/learnings
files all live under `~/.openrevuwer/` (override with the `OPENREVUWER_HOME`
env var) — not inside the package install — so they survive upgrades and
don't need write access to wherever npm put the package.

If you want scheduling (cron/launchd/Task Scheduler) to keep working long
term, install with `npm install -g` rather than running through `npx` —
`npx` without a global install can run from a temporary cache location that
gets cleaned up, breaking the scheduled entry.

## Set up (interactive wizard)

```bash
openrevuwer init
```

This will:
1. List every account authenticated in `gh` and ask which complete set of
   accounts should search for review requests and post reviews. Existing
   configured accounts are preselected.
2. For each account, show every accessible repository as a searchable
   multi-select. Every account must explicitly watch at least one repository;
   there is no global-search mode.
3. Seed one shared prompt per GitHub host/repository and one independent
   learnings file per host/account/repository. Existing files are never
   overwritten.
4. Detect Claude Code / Codex on your `PATH` and check whether each is
   actually authenticated (not just installed). You can also enter a custom
   reviewer command instead. Codex runs in ephemeral, read-only mode and
   accepts the prompt-only review workspace without requiring a Git checkout.
5. Ask how many independent review focus categories to run per PR. The
   recommended choice runs all four categories plus synthesis; lower choices
   reduce reviewer calls by skipping later categories.
6. Ask whether completed polls should show desktop notifications (enabled by
   default).
7. Offer one schedule for the complete multi-account poller.
8. Preview the config, deterministic review-file paths, and schedule, then ask
   once before applying them.

Cancelling before the final confirmation leaves the config and review files
unchanged.

### Setting up by hand instead

If you'd rather skip the wizard, write `~/.openrevuwer/config.json` yourself.
A template is bundled with the package — find it with:

```bash
npm root -g
```

then copy `<that path>/openrevuwer/config.example.json` to
`~/.openrevuwer/config.json` and fill in the fields:

| Field | Meaning |
|---|---|
| `configVersion` | Required schema version; currently `2`. Older/single-account shapes are rejected. |
| `githubAccounts` | Non-empty array of `{ hostname, username, repositories }`. Each `repositories` value is a non-empty array of explicit `OWNER/REPO` strings. |
| `reviewerCommand` | Shell command that reads a prompt on stdin and prints review text/JSON on stdout, e.g. `"claude -p --output-format text"`. The former generated default `"codex exec"` is upgraded in memory to the safe scheduled-review command automatically; other custom commands are preserved unchanged apart from existing whitespace normalization. |
| `reviewBatchSize` | Global maximum number of concurrent PR reviews across all accounts (defaults to `5`). |
| `reviewFocusCount` | Number of independent review focus categories to run before the final synthesis pass (defaults to `4`, maximum `4`). The onboarding wizard asks for this; lower values skip later categories to trade coverage for runtime. |
| `desktopNotifications` | Show one audible desktop notification after a poll produces review results or needs attention (defaults to `true`). Set to `false` to opt out. |
| `stateFile` | Where last-reviewed commit SHAs are tracked (defaults to `./state.json`, resolved under `~/.openrevuwer/`). |
| `lockFile` | Stable lock namespace used to prevent two overlapping poll runs from racing on `stateFile` (defaults to `<stateFile>.lock`, resolved under `~/.openrevuwer/`; the legacy field name is retained for compatibility). Ownership uses one of a deterministic sequence of kernel-managed loopback listeners, not a filesystem lock file, so distinct keys can bypass port collisions and crashes cannot leave stale lock artifacts. If a poll run is still in flight when the next scheduled tick fires, the new run logs a message and exits instead of running concurrently. |

`~/.openrevuwer/config.json` is local, machine-specific config — it's never
committed to a repo. It stores hostnames and usernames, never tokens. Each poll
retrieves every selected account's token from the GitHub CLI credential store
and passes it only to that account's child `gh` processes. It never changes
the globally active `gh` account.

## Try it (dry run)

Before trusting openrevuwer to post anything, run it in dry-run mode. This does
everything — search, diff fetch, prompt build, invoke the reviewer CLI — but
stops short of posting to GitHub:

```bash
openrevuwer --dry-run
```

To exercise only one configured identity:

```bash
openrevuwer --dry-run --account work-account@github.com
```

You should see one block per matching PR with a summary and finding count.
Each review runs four independent focused passes plus a final synthesis pass by
default, so a dry run can take longer than a single reviewer invocation.
If a PR is already up to date in `~/.openrevuwer/state.json`, it's skipped and
logged as such.

## Run for real

```bash
openrevuwer
```

This posts an actual GitHub PR review (inline comments + summary) for every
PR where any configured identity is the requested reviewer and the head commit
hasn't been reviewed by that identity yet. The queue is round-robin across
accounts and uses one global concurrency limit. Set `reviewBatchSize` in
`~/.openrevuwer/config.json` to change that limit. On
success, it records the reviewed SHA in
`~/.openrevuwer/state.json` so the same commit isn't re-reviewed next run.
State keys include the selected GitHub account, so two accounts can review
the same PR independently. Reviews also carry an opaque hidden marker; if a
post succeeds but the local state write fails, the next poll reconciles the
existing review instead of posting a duplicate.

If one account, repository, or PR fails, openrevuwer logs the account-prefixed
failure, continues all independent work, and exits nonzero after the poll. It
never posts a broken or empty review, and leaves failed PR state untouched so
the next run retries automatically. A global operation lock prevents
overlapping polls from duplicating reviews; a second poll logs that one is
already active and exits successfully. Fatal startup failures are also written
to `~/.openrevuwer/poll.log`, including on Windows where the scheduler does not
redirect process output.

## Desktop notifications

When a poll reviews, re-reviews, dry-runs, or recovers one or more PRs,
openrevuwer sends one audible desktop notification after the complete batch
and all state writes finish. The notification lists up to three
`OWNER/REPO#N — title` entries and summarizes any remaining entries. Mixed
results are presented as an attention notification, with failed PRs
prioritized and successful PRs still represented.

No notification is sent when there is no work or when another poll owns the
operation lock. Notification delivery is best-effort: it has a five-second
timeout, logs failures to `~/.openrevuwer/poll.log`, and never changes a review
or state outcome. On macOS, openrevuwer uses the application-bundled
`terminal-notifier` shipped by `node-notifier`, so scheduled polls have a stable
Notification Center identity instead of relying on background AppleScript.
Windows uses PowerShell toasts, and Linux uses `notify-send`. A logged-in
graphical desktop session is required; headless and logged-out scheduler
sessions cannot display a toast. Linux systems must provide `notify-send`.

Set `"desktopNotifications": false` in the config to opt out. For temporary or
headless execution, `OPENREVUWER_DESKTOP_NOTIFICATIONS=0` also suppresses
notifications, including fatal startup notifications that happen before the
config can be loaded.

## Scheduling

If you skipped scheduling during `init`, or want to change it later, rerun
the wizard (it's safe to run again — it just asks the same questions) or set
it up manually:

- **cron** (macOS/Linux): add a line like
  ```
  */15 * * * * '/usr/bin/node' '/absolute/path/to/openrevuwer/bin/scheduled.mjs' '/Users/you/.openrevuwer/scheduler-environment.json' >> '/Users/you/.openrevuwer/poll.log' 2>&1
  ```
- **launchd** (macOS): the wizard writes a plist to
  `~/Library/LaunchAgents/ai.socialpost.openrevuwer.poll.plist` and loads it with
  `launchctl load`.
- **Windows Task Scheduler**: the wizard runs
  `schtasks /create /sc minute /mo <N> /tn openrevuwer-poll /tr "node ...\bin\scheduled.mjs ...\scheduler-environment.json"`.

The wizard only offers schedulers supported by the current operating system.
Installed schedules use an environment file under `~/.openrevuwer/` to retain
the `PATH` validated during setup and any `OPENREVUWER_HOME` override. This
keeps `gh` and the selected reviewer CLI discoverable under the restricted
environments used by cron, launchd, and Task Scheduler. The file contains
paths only, never GitHub or reviewer credentials.

## Customizing reviews

- **`~/.openrevuwer/docs/review-prompts/<host>/<owner>/<repo>.md`** — the
  prompt shared by every configured reviewer of that host/repository: framing, review
  criteria, and where the PR title/body/diff and past learnings get
  inserted (via `{{pr_title}}`, `{{pr_number}}`, `{{pr_body}}`, `{{diff}}`,
  and `{{learnings_section}}` placeholders). `init` seeds one copy per
  watched repo from the bundled default the first time you add that repo;
  edit a repo's copy directly any time — reorder sections, change the
  criteria, adjust the framing, no code change or wizard rerun needed — and
  it never affects any other repo's prompt. Re-running `init` never
  overwrites an existing copy. The strict JSON output-format instruction
  the review-posting logic depends on to anchor inline comments is always
  appended automatically and isn't part of this file, so an edit here can't
  break that regardless of what you change.
- **`~/.openrevuwer/docs/learnings/<host>/<username>/<owner>/<repo>.md`** —
  corrections isolated to one reviewer identity and repository (for example,
  "don't flag X, it's intentional because Y"). `init` creates each selected
  target's file and never overwrites its contents.

## Troubleshooting

- **`gh` not authenticated** — `gh auth login`, then rerun.
- **Configured GitHub account is unavailable** — authenticate it with
  `gh auth login --hostname <hostname>`, or rerun init and select another
  account. Polling does not depend on whichever account is globally active.
- **Reviewer CLI "found but not authenticated"** during `init` — run the
  login command it prints (e.g. `claude /login`), then continue.
- **Codex reports "Not inside a trusted directory"** — current versions
  automatically upgrade the old generated `"codex exec"` command to
  `"codex exec --skip-git-repo-check --ephemeral --sandbox read-only"`.
  Upgrade openrevuwer or rerun `openrevuwer init`; custom Codex commands are
  intentionally not rewritten.
- **Nothing happens on a poll run** — check `~/.openrevuwer/poll.log` for
  the specific failure (search failed, reviewer adapter failed, post
  rejected, etc.).
- **Reviews work but notifications do not** — make sure the poll runs while
  you are logged into a graphical desktop session. On Linux, install
  `notify-send`; then check `~/.openrevuwer/poll.log` for a
  `[notification]` warning.
- **A review didn't fully post** — openrevuwer validates finding line numbers
  against the actual diff before posting; anything it can't anchor to a real
  line gets folded into the review's summary text instead of being dropped
  silently, so check the summary for an "Additional findings" section.

## License

[MIT](./LICENSE)
