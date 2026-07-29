# OpenMergeLens

**A local CLI that automates AI code reviews for GitHub pull requests using
Codex, Claude Code, or any compatible MCP-enabled reviewer CLI.**

[Website](https://suguspnk.github.io/openmergelens/) ·
[npm](https://www.npmjs.com/package/openmergelens) ·
[Documentation](#install)

OpenMergeLens runs on your own machine on a schedule (cron / launchd / Windows
Task Scheduler) — no GitHub App, webhook, or server. It uses `gh` to find PRs
where you're the requested reviewer and a compatible reviewer CLI (Codex,
Claude Code, or a custom MCP-enabled command) to generate an inline,
severity-tagged GitHub review.

Start with a dry run, review its output, and only then enable posting.

Full design rationale lives in [PRD.md](./PRD.md). This doc is just
setup.

## Prerequisites

Before running anything, make sure you have:

1. **Node.js 22.14+ or 24+**
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
   - A custom CLI that can read a prompt from stdin, print text/JSON to
     stdout, attach a per-run MCP server, and restrict access to the named MCP
     inspection tool.

## Install

```bash
npm install -g openmergelens
```

Or skip the install and run it on demand with `npx`:

```bash
npx openmergelens init
```

Useful command metadata is available without configuration:

```bash
openmergelens --help
openmergelens --version
```

Config, poll state, logs, and your editable per-repo review prompts/learnings
files all live under `~/.openmergelens/` (override with the `OPENMERGELENS_HOME`
env var) — not inside the package install — so they survive upgrades and
don't need write access to wherever npm put the package.

If you want scheduling (cron/launchd/Task Scheduler) to keep working long
term, install with `npm install -g` rather than running through `npx` —
`npx` without a global install can run from a temporary cache location that
gets cleaned up, breaking the scheduled entry.

## Set up (interactive wizard)

```bash
openmergelens init
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
5. Require explicit consent for every selected repository before its source
   code, pull-request content, or personal data can be processed by the
   selected third-party AI provider. Declining leaves setup unchanged.
6. Ask how many independent review focus categories to run per PR. The
   recommended choice runs all four categories plus synthesis; lower choices
   reduce reviewer calls by skipping later categories.
7. Ask whether completed polls should show desktop notifications (enabled by
   default). After setup is applied, send a test notification, confirm that it
   appeared, and show platform-specific recovery steps if the operating system
   suppresses it.
8. Offer one schedule for the complete multi-account poller.
9. Preview the config, deterministic review-file paths, and schedule, then ask
   once before applying them.

Cancelling before the final confirmation leaves the config and review files
unchanged.

### Setting up by hand instead

If you'd rather skip the wizard, write `~/.openmergelens/config.json` yourself.
A template is bundled with the package — find it with:

```bash
npm root -g
```

then copy `<that path>/openmergelens/config.example.json` to
`~/.openmergelens/config.json` and fill in the fields:

| Field | Meaning |
|---|---|
| `configVersion` | Required schema version; currently `2`. Older/single-account shapes are rejected. |
| `githubAccounts` | Non-empty array of `{ hostname, username, repositories, aiProcessingConsent }`. Each repository list contains explicit `OWNER/REPO` strings. `aiProcessingConsent` must separately list every selected repository authorized for third-party AI processing; unlisted repositories never reach the reviewer. |
| `reviewerCommand` | Agent command that reads a prompt on stdin, uses the provided MCP inspection tool, and prints review JSON on stdout. Generated Codex/Claude commands are configured automatically. A custom command must include both `{{mcp_config}}` and `{{mcp_tool}}` in the appropriate MCP-config and allowed-tool arguments; OpenMergeLens fills them per review and rejects custom commands without this explicit contract. |
| `reviewBatchSize` | Global maximum number of concurrent PR reviews across all accounts (defaults to `5`). |
| `reviewFocusCount` | Number of independent review focus categories to run before the final synthesis pass (defaults to `4`, maximum `4`). The onboarding wizard asks for this; lower values skip later categories to trade coverage for runtime. |
| `desktopNotifications` | Show one audible desktop notification after a poll produces review results or needs attention (defaults to `true`). Set to `false` to opt out. |
| `stateFile` | Where last-reviewed commit SHAs are tracked (defaults to `./state.json`, resolved under `~/.openmergelens/`). |

`~/.openmergelens/config.json` is local, machine-specific config — it's never
committed to a repo. It stores hostnames and usernames, never tokens. Each poll
retrieves every selected account's token from the GitHub CLI credential store.
The reviewer never receives that token. Instead, OpenMergeLens exposes one
temporary structured inspection tool backed by a per-review local gateway
that permits only GET operations for the fixed PR and its repository. The
generated Codex command denies host-file reads outside its isolated workspace,
has no direct network access, and fails closed on unknown configuration.

## Try it (dry run)

Before trusting OpenMergeLens to post anything, run it in dry-run mode. This does
everything — search, diff fetch, invoke the reviewer agent against the linked
PR, and validate findings against the fetched diff — but
stops short of posting to GitHub:

```bash
openmergelens --dry-run
```

To exercise only one configured identity:

```bash
openmergelens --dry-run --account work-account@github.com
```

You should see one block per matching PR with a summary and finding count.
Each review runs four independent focused passes plus a final synthesis pass by
default. Every pass uses `gh` to inspect the PR independently, so a dry run can
take longer than a single reviewer invocation.
If a PR is already up to date in `~/.openmergelens/state.json`, it's skipped and
logged as such.

## Run for real

```bash
openmergelens
```

This posts an actual GitHub PR review (inline comments + summary) for every
PR where any configured identity is the requested reviewer and the head commit
hasn't been reviewed by that identity yet. The queue is round-robin across
accounts and uses one global concurrency limit. Set `reviewBatchSize` in
`~/.openmergelens/config.json` to change that limit. On
success, it records the reviewed SHA in
`~/.openmergelens/state.json` so the same commit isn't re-reviewed next run.
State keys include the selected GitHub account, so two accounts can review
the same PR independently. Reviews also carry an opaque hidden marker; if a
post succeeds but the local state write fails, the next poll reconciles the
existing review instead of posting a duplicate.

Every posted review includes a visible notice that it was generated by
OpenMergeLens using AI on behalf of the authenticated reviewer. Reviews remain
non-binding `COMMENT` reviews; OpenMergeLens never approves a PR or requests
changes automatically.

If one account, repository, or PR fails, OpenMergeLens logs the account-prefixed
failure, continues all independent work, and exits nonzero after the poll. It
never posts a broken or empty review, and leaves failed PR state untouched so
the next run retries automatically. A global operation lock prevents
overlapping polls from duplicating reviews; a second poll logs that one is
already active and exits successfully. Fatal startup failures are also written
to `~/.openmergelens/poll.log`, including on Windows where the scheduler does not
redirect process output.

## Desktop notifications

When a poll reviews, re-reviews, dry-runs, or recovers one or more PRs,
OpenMergeLens sends one audible desktop notification after the complete batch
and all state writes finish. The notification lists up to three
`OWNER/REPO#N — title` entries and summarizes any remaining entries. Mixed
results are presented as an attention notification, with failed PRs
prioritized and successful PRs still represented.

No notification is sent when there is no work or when another poll owns the
operation lock. Notification delivery is best-effort: it has a five-second
timeout, logs failures to `~/.openmergelens/poll.log`, and never changes a review
or state outcome. On macOS 13 and later, OpenMergeLens includes a universal
build of the maintained `alerter` project and uses the recognized Terminal
notification identity required by current macOS releases. macOS 12 and earlier
retain the smaller legacy `terminal-notifier` helper. Both helpers support Intel
and Apple Silicon without relying on background AppleScript or Rosetta. Windows
uses PowerShell toasts, and Linux uses `notify-send`. A logged-in graphical
desktop session is required; headless and logged-out scheduler sessions cannot
display a toast. Linux systems must provide `notify-send`.

Set `"desktopNotifications": false` in the config to opt out. For temporary or
headless execution, `OPENMERGELENS_DESKTOP_NOTIFICATIONS=0` also suppresses
notifications, including fatal startup notifications that happen before the
config can be loaded.

When notifications are enabled, `openmergelens init` sends a test notification
after saving the configuration and asks whether it appeared. If delivery fails
or the operating system accepts the notification without displaying it, the
wizard prints the relevant notification-settings steps. Operating-system
permission still requires user confirmation and cannot be enabled silently.

## Scheduling

If you skipped scheduling during `init`, or want to change it later, rerun
the wizard (it's safe to run again — it just asks the same questions) or set
it up manually:

- **cron** (macOS/Linux): add a line like
  ```
  */15 * * * * '/usr/bin/node' '/absolute/path/to/openmergelens/bin/scheduled.mjs' '/Users/you/.openmergelens/scheduler-environment.json' >> '/Users/you/.openmergelens/poll.log' 2>&1
  ```
- **launchd** (macOS): the wizard writes a plist to
  `~/Library/LaunchAgents/io.github.suguspnk.openmergelens.poll.plist` and loads it with
  `launchctl load`.
- **Windows Task Scheduler**: the wizard runs
  `schtasks /create /sc minute /mo <N> /tn openmergelens-poll /tr "node ...\bin\scheduled.mjs ...\scheduler-environment.json"`.

The wizard only offers schedulers supported by the current operating system.
Installed schedules use an environment file under `~/.openmergelens/` to retain
the `PATH` validated during setup and any `OPENMERGELENS_HOME` override. This
keeps `gh` and the selected reviewer CLI discoverable under the restricted
environments used by cron, launchd, and Task Scheduler. The file contains
paths only, never GitHub or reviewer credentials.

## Privacy, security, and cost

OpenMergeLens has no server, account system, analytics, or telemetry. It stores
configuration, review state, logs, prompts, and learnings locally. GitHub data
is retrieved through your authenticated `gh` installation. GitHub credentials
are never written to OpenMergeLens config and are not passed to the reviewer;
the reviewer receives a temporary read-only tool scoped to one repository and
pull request.

Pull-request content is untrusted input. OpenMergeLens validates tool requests,
uses shell-free process arguments, bounds subprocess output, rechecks the head
commit before posting, and sanitizes diagnostics. A custom reviewer remains
trusted local software and is governed by its provider's privacy, billing, and
usage terms.

Repository selection and AI-processing consent are separate controls. Setup
requires repository-by-repository confirmation that the owner permits the
selected provider to process source code, PR content, and personal data under
acceptable retention, training, confidentiality, data-residency, and DPA
terms. Removing a repository from `aiProcessingConsent` prevents searches and
reviewer invocation for that repository. Existing configurations without this
field fail closed until `openmergelens init` records consent.

The default four focused review passes plus synthesis make five reviewer
invocations per PR. Lower `reviewFocusCount` to reduce usage. GitHub and
reviewer rate limits can still delay or fail work; failures leave review state
untouched so a later poll retries. Review POSTs are globally serialized with
at least one second between mutations. A GitHub `Retry-After` or rate-reset
signal pauses later review posts; otherwise a detected rate-limit response
backs off for at least one minute.

See the
[security policy](https://github.com/suguspnk/openmergelens/blob/main/SECURITY.md)
for the security model and private reporting process.

## Known limitations

- The host machine must be awake, online, and able to run `gh` and the reviewer
  when the schedule fires.
- Only explicitly selected repositories are searched.
- Notifications require a logged-in graphical session; Linux also requires
  `notify-send`.
- Reviewer quality, latency, context limits, and cost depend on the configured
  reviewer.
- OpenMergeLens supports maintained Node.js 22 and 24 releases. EOL Node.js
  versions are not supported.

## Customizing reviews

- **`~/.openmergelens/docs/review-prompts/<host>/<owner>/<repo>.md`** — the
  prompt shared by every configured reviewer of that host/repository: framing, review
  criteria, and where the PR URL and past learnings get inserted (via
  `{{pr_url}}`, `{{pr_number}}`, and `{{learnings_section}}` placeholders).
  Existing templates using `{{diff}}` remain compatible: that placeholder now
  expands to the fixed instructions for inspecting the linked PR with `gh`,
  rather than embedding the diff. `{{pr_title}}` and `{{pr_body}}` are retained
  for compatibility but direct the agent to retrieve current metadata.
  `init` seeds one copy per
  watched repo from the bundled default the first time you add that repo;
  edit a repo's copy directly any time — reorder sections, change the
  criteria, adjust the framing, no code change or wizard rerun needed — and
  it never affects any other repo's prompt. Re-running `init` never
  overwrites an existing copy. The strict JSON output-format instruction
  the review-posting logic depends on to anchor inline comments is always
  appended automatically and isn't part of this file, so an edit here can't
  break that regardless of what you change.
- **`~/.openmergelens/docs/learnings/<host>/<username>/<owner>/<repo>.md`** —
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
  automatically upgrade known older generated Codex commands to the current
  ephemeral, strict, read-only command. Upgrade OpenMergeLens or rerun
  `openmergelens init`; custom Codex commands are intentionally not rewritten.
- **Nothing happens on a poll run** — check `~/.openmergelens/poll.log` for
  the specific failure (search failed, reviewer adapter failed, post
  rejected, etc.).
- **Reviews work but notifications do not** — make sure the poll runs while
  you are logged into a graphical desktop session. Rerun `openmergelens init`
  to send a test notification and get platform-specific recovery steps. On
  Linux, install `notify-send`; then check `~/.openmergelens/poll.log` for a
  `[notification]` warning.
- **A review didn't fully post** — OpenMergeLens validates finding line numbers
  against the actual diff before posting; anything it can't anchor to a real
  line gets folded into the review's summary text instead of being dropped
  silently, so check the summary for an "Additional findings" section.

## Uninstall

Remove the scheduler before uninstalling the package:

- **cron:** run `crontab -e` and remove the line ending in
  `# openmergelens poll`.
- **launchd:** run
  `launchctl unload ~/Library/LaunchAgents/io.github.suguspnk.openmergelens.poll.plist`,
  then delete that plist.
- **Windows Task Scheduler:** run
  `schtasks /delete /f /tn openmergelens-poll`.

Then run `npm uninstall -g openmergelens`. Your local state is intentionally
preserved. Delete `~/.openmergelens` only if you also want to permanently
remove config, review history, logs, prompts, and learnings.

## Community and releases

See the
[contribution guide](https://github.com/suguspnk/openmergelens/blob/main/CONTRIBUTING.md),
[support policy](https://github.com/suguspnk/openmergelens/blob/main/SUPPORT.md),
[code of conduct](https://github.com/suguspnk/openmergelens/blob/main/CODE_OF_CONDUCT.md),
and [changelog](./CHANGELOG.md). Maintainer release steps are documented in
[docs/RELEASING.md](https://github.com/suguspnk/openmergelens/blob/main/docs/RELEASING.md).

## License

[MIT](./LICENSE)
