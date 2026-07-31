# Tech Stack Standards

This document is **context for AI coding agents** working on OpenMergeLens, not
end-user documentation. It records industry best practices, common
pitfalls, and authoritative references for every component in this repo's
stack, so an agent can make stack-appropriate decisions without re-deriving
them from scratch. Keep entries dense and actionable; update via the
`tech-stack-standards` skill when the stack changes.

## Table of Contents

- [Detected Stack](#detected-stack)
- [Node.js (ESM + child_process)](#nodejs-esm--childprocess)
- [@clack/prompts](#clackprompts)
- [GitHub CLI (`gh`)](#github-cli-gh)
- [pnpm](#pnpm)
- [Shell/Command Injection Avoidance](#shellcommand-injection-avoidance)
- [OS Scheduling (cron / launchd / Task Scheduler)](#os-scheduling-cron--launchd--task-scheduler)

## Detected Stack

| Component | Version | Where used |
|---|---|---|
| Node.js | `>=18` (engines), ESM (`"type": "module"`) | `bin/`, `lib/` (entire codebase) |
| @clack/prompts | `^1.7.0` | `bin/init.mjs` (setup wizard) |
| GitHub CLI (`gh`) | shelled out, no pinned version | `lib/github.mjs` |
| pnpm | lockfileVersion `9.0` | repo-wide (`pnpm-lock.yaml`) |
| Shell/command execution pattern | `node:child_process` `execFile` | `lib/github.mjs`, `lib/agent-detect.mjs`, `lib/scheduler.mjs` |
| OS scheduling | cron, launchd, Windows Task Scheduler | `lib/scheduler.mjs` |

## Node.js (ESM + child_process)

### Overview

OpenMergeLens is a Node.js 18+ ESM CLI tool (`"type": "module"` in
`package.json`) with no server component. It shells out to `gh` and to a
user-configured reviewer CLI via `node:child_process`, so `execFile`
discipline is central to its security model.

### Best Practices

- Stay ESM-first (`"type": "module"`), but be aware Node 22+ added
  `require(esm)`, so CJS consumers can load ESM packages without dual-publish
  workarounds if that's ever needed.
- Declare an explicit `"engines": { "node": ">=18.0.0" }` (or higher) in
  `package.json` to codify the minimum runtime for a tool distributed to run
  on other machines via cron/launchd.
- Target an actively-maintained LTS as the real floor, not just the oldest
  version that happens to work: Node 20 is approaching/at EOL in the
  2026 window; Node 22 is a safer maintenance baseline for new tooling.
- Prefer built-ins (native `fetch`, `node:test`, `AbortController`) over
  legacy polyfill packages to keep the dependency surface minimal.
- Use `execFile` (or `spawn` with the default `shell: false`), never `exec`
  or `shell: true`, whenever any argument is derived from external or
  untrusted content. This is exactly the OpenMergeLens case because PR titles, bodies,
  diffs, and reviewer CLI output are all untrusted.
- Never set `shell: true` on `execFile`/`spawn` to work around quoting
  issues; fix the argument array instead. Node's own docs deprecate this
  pattern (DEP0190) and warn against passing unsanitized input when a shell
  is enabled.

### Common Pitfalls

- Avoid `exec()`/`execSync()` with any string built from concatenating
  external content (PR titles, diff text, reviewer output) because both
  always spawn a shell and interpolate the string before parsing: Node's
  docs state that unsanitized input here can trigger arbitrary command
  execution.
- Avoid `spawn(cmd, args, { shell: true })` even to fix a Windows quoting
  bug, because it reintroduces the injection surface `execFile`/`spawn` was
  chosen to avoid, and triggers a DEP0190 deprecation warning.
- Avoid treating a "configurable reviewer command" as safe just because a
  trusted user configured the base command string: the *arguments* passed
  to it at runtime (diff content, PR metadata) are still untrusted. Pass
  those as separate array elements or via stdin, never string-interpolated
  into one command line.
- Avoid relying on the `"engines"` field as a hard enforcement mechanism;
  npm/Node only warn by default unless `engine-strict` is set, so it doesn't
  reliably gate the Node version on an end user's machine running this via
  cron.

### References

- [Child process: Node.js Documentation](https://nodejs.org/api/child_process.html)
- [Node.js Deprecations: DEP0190](https://nodejs.org/api/deprecations.html#DEP0190)
- [nodejs-security.com: Secure JavaScript Coding Practices Against Command Injection](https://www.nodejs-security.com/blog/secure-javascript-coding-practices-against-command-injection-vulnerabilities)

## @clack/prompts

### Overview

`@clack/prompts` (`^1.7.0`) powers the interactive setup wizard in
`bin/init.mjs`: repo multi-select, confirmations, text input, and spinners.

### Best Practices

- Check every prompt's return value with `isCancel()` immediately after each
  call (`text`, `confirm`, `select`, `multiselect`), and call
  `p.cancel('message')` + `process.exit(0)` when true.
- Use `group()` to bundle a wizard's related prompts into one unit with a
  single `onCancel` handler, instead of chaining individual `await` calls
  with cancel checks scattered everywhere.
- Wrap long-running work (`gh` calls, network requests) in `spinner()`;
  `.start('message')` before and `.stop('message')` after, so the repo search
  or auth check gives visible feedback instead of a frozen terminal.
- Use `validate()` on `text` prompts to catch bad input inline (e.g., an
  empty reviewer command or malformed cron expression); return a string to
  reject, return nothing to accept.
- Keep a multi-select's `options` synchronous: pre-fetch data (e.g. the
  repo list) before invoking the prompt rather than doing async work inside
  the options callback/getter.
- Bracket the wizard with `intro()`/`outro()` for a clear visual
  start/end, rather than mixing in raw `console.log`.

### Common Pitfalls

- Avoid forgetting `isCancel()` checks, because Ctrl+C returns a special
  cancel symbol rather than throwing: left unchecked, that symbol can flow
  downstream as a "value" (e.g. into a config field) and corrupt state or
  crash obscurely later.
- Avoid assuming clack prompts behave identically on every runtime, because
  interactive terminal UI depends on a real TTY: non-TTY/CI/piped-stdin
  contexts can hang or misrender. Guard `bin/init.mjs`'s interactive path
  behind a TTY check (`process.stdin.isTTY`) with a non-interactive
  fallback.
- Avoid layering a custom pre-filter on top of clack's built-in
  autocomplete/multiselect filter, because clack reapplies its own filter to
  whatever the options getter returns. This double-filters. If you
  pre-filter or pre-sort yourself, pass a pass-through `filter` function.
- Avoid scattering `process.exit()` across every individual prompt's cancel
  handler when using `group()`: centralize cancellation once in `onCancel`
  so partial results are available for cleanup/logging instead of leaving
  the group half-answered.

### References

- [@clack/prompts official docs](https://bomb.sh/docs/clack/packages/prompts/)
- [@clack/prompts README (GitHub)](https://github.com/bombshell-dev/clack/blob/main/packages/prompts/README.md)
- [@clack/prompts on npm](https://www.npmjs.com/package/@clack/prompts)

## GitHub CLI (`gh`)

### Overview

OpenMergeLens shells out to `gh` (via `execFile`, no shell) to search for PRs,
fetch metadata/diffs, and post reviews. It runs unattended on a schedule, not
interactively.

### Best Practices

- Use `--json <fields> --jq '<filter>'` for all structured data extraction
  instead of parsing human-readable text output, e.g.
  `gh pr list --json number,title,headRefOid --jq '.[]'`.
- Provide all inputs via flags and disable prompts explicitly in
  non-interactive contexts (e.g. `GH_NO_PROMPT=1`) so a missing flag fails
  loudly instead of hanging on a TTY prompt a cron job can never answer.
- Authenticate via environment variable (`GH_TOKEN` or `GITHUB_TOKEN`), not
  `gh auth login`, in unattended/scheduled contexts: `gh auth login` is
  interactive/browser-based. Prefer a fine-grained PAT scoped to the minimum
  required repos/permissions over a broad classic PAT.
- Use `--paginate` for any `gh api` search or list call that can exceed one
  page (e.g. `/search/issues`) rather than hand-rolling cursor logic;
  results are silently truncated to the first page without it.
- Check exit codes and stderr on every invocation; consult
  `gh help exit-codes` to distinguish auth errors from not-found or network
  failures instead of treating every non-zero exit the same way.
- Proactively check `gh api rate_limit --jq '.rate.remaining'` when polling
  frequently, and add spacing/backoff between write calls (posting
  reviews/comments) since GitHub's secondary/abuse rate limiting is
  independent of the hourly quota.

### Common Pitfalls

- Avoid parsing `gh`'s default human-readable/table text output, because
  column widths and wording aren't a stable contract across `gh` versions;
  `--json`/`--jq` fields are the versioned interface.
- Avoid assuming `gh api` requests are authenticated without checking,
  because credential resolution can silently fail (e.g. macOS Keychain
  lookups timing out), surfacing only as a downstream 401/403 with no
  explicit warning. Set `GH_TOKEN` explicitly for automation rather than
  trusting ambient keychain-based auth.
- Avoid using a broad classic PAT for scheduled multi-repo automation,
  because a leaked classic PAT can touch every repo its owner can access;
  scope a fine-grained PAT to only what OpenMergeLens needs.
- Avoid firing rapid successive write calls (posting multiple reviews in
  quick succession) in a poll loop without backoff, because GitHub's
  secondary rate limits throttle burst patterns independently of the
  5,000/hour ceiling.

### References

- [GitHub CLI Manual: gh api](https://cli.github.com/manual/gh_api)
- [Scripting with GitHub CLI: The GitHub Blog](https://github.blog/engineering/engineering-principles/scripting-with-github-cli/)
- [GitHub CLI Manual index](https://cli.github.com/manual/index)

## pnpm

### Overview

OpenMergeLens uses pnpm (`pnpm-lock.yaml`, lockfileVersion `9.0`) as its package
manager for a single-package (non-monorepo) CLI project.

### Best Practices

- Commit `pnpm-lock.yaml` to version control because it is the source of truth for
  resolved dependency versions, not a machine-specific artifact.
- Run installs with frozen-lockfile intent in any automated/CI context
  (`pnpm install --frozen-lockfile`); pnpm auto-detects CI and defaults to
  this, but pin the flag explicitly for clarity.
- Declare an `engines` field (`node`, `pnpm` minimum versions) and pair it
  with `engineStrict`/equivalent config so installs fail fast on a wrong
  Node/pnpm version instead of producing a subtly broken install.
- Use `pnpm dlx <pkg>` for one-off tool execution instead of `pnpm add -g`,
  to avoid global version drift; reserve `-g` installs for tools invoked
  constantly across many projects.
- Declare every direct dependency explicitly: don't rely on transitive
  ("phantom") dependencies, since pnpm's non-hoisted `node_modules`
  structure will break code that imports a package it never declared.
- Since pnpm v10, dependency lifecycle scripts (`preinstall`/`postinstall`)
  don't run by default. If a legitimate dependency needs its install
  script, allowlist it explicitly via `pnpm.onlyBuiltDependencies` rather
  than disabling the protection globally.

### Common Pitfalls

- Avoid assuming npm's flat hoisting behavior, because pnpm's strict
  structure surfaces "missing dependency" errors for phantom dependencies
  that only worked before by accident.
- Avoid running plain `pnpm install` in CI without frozen-lockfile intent,
  because an unaccompanied `package.json` edit can let CI silently
  regenerate the lockfile instead of failing the build on drift.
- Avoid keeping both `package-lock.json` and `pnpm-lock.yaml` in the repo,
  because the lockfile formats aren't interchangeable and stale/duplicate
  lockfiles cause nondeterministic installs.
- Avoid blanket-disabling pnpm's v10+ script-execution security default,
  because it deliberately blocks arbitrary dependency lifecycle scripts to
  reduce supply-chain risk: allowlist only vetted packages.

### References

- [pnpm CLI: install](https://pnpm.io/cli/install)
- [pnpm CLI: dlx](https://pnpm.io/cli/dlx)
- [pnpm Limitations](https://pnpm.io/limitations)

## Shell/Command Injection Avoidance

### Overview

OpenMergeLens shells out to two untrusted-content-adjacent targets: `gh` and a
user-configured reviewer CLI. Every invocation deliberately uses `execFile`
(argv array, no shell) instead of `exec`, specifically to prevent PR
titles, bodies, and diffs, which are external and attacker-influenceable, from being
interpreted as shell syntax.

### Best Practices

- Always pass arguments as an array, never as a concatenated/interpolated
  string: each array element reaches the OS exec syscall as a discrete
  argument, so shell metacharacters (`;`, `|`, `&&`, backticks, `$()`) are
  treated as literal text, never parsed as syntax.
- Never set `shell: true` (or a shell path) when any argument is untrusted;
  this re-introduces full shell parsing and collapses the exact protection
  `execFile` provides.
- Prefer built-in library functionality over shelling out at all where an
  equivalent exists; where shelling out is unavoidable (as with `gh` and the
  reviewer CLI), keep untrusted content out of argv where possible. For example,
  write diff content to a temp file or pipe it via stdin instead of passing
  it as an argv string.
- Apply allowlist validation on top of `execFile`, not instead of it;
  validate repo names, PR numbers, and branch names against strict patterns
  before they reach argv, since `execFile` protects against shell
  reinterpretation but not against a target binary misreading an argument
  as a flag.
- Be deliberate about which channel carries untrusted content: argv vs.
  stdin vs. env vars. Large or arbitrary blobs (PR descriptions, diffs,
  reviewer output) are safer via stdin/temp file than argv. This avoids
  argv length limits and avoids leaking content into process listings
  (`ps aux` shows argv, not stdin).
- Run child processes with minimal privileges/scoped credentials: don't
  hand a child process a broader token or environment than it needs.

### Common Pitfalls

- Avoid `child_process.exec()` (or `shell: true`) with untrusted input,
  because it invokes `/bin/sh -c "<string>"` and shell metacharacters in
  that input can chain or substitute arbitrary commands.
- Avoid string-concatenating a command line even when using
  `execFile`/`spawn` (e.g. building one argv string and splitting it
  yourself), because this silently reintroduces a reparsing step and breaks
  on real-world quoting/spacing in PR titles.
- Avoid assuming `execFile` is safe against every downstream binary;
  some binaries interpret their own arguments as scripts or forward them to
  a shell internally (`node -e`, `python -c`, or a user-configured
  `reviewerCommand` that is itself `bash -c "..."`). OpenMergeLens's own use of
  `execFile` doesn't protect against unsafe interpolation one level down
  inside a user-configured reviewer command.
- Avoid assuming "no shell metacharacters" is sufficient: argument/flag
  injection is a separate risk: a value like `--upload-file=/etc/passwd`
  passed as an argv element with zero shell involved can still be
  misinterpreted as a flag by the target binary. Validate expected shape or
  prefix ambiguous values (e.g. `--`) to force positional interpretation.

### References

- [OWASP OS Command Injection Defense Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html)
- [OWASP Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Injection_Prevention_Cheat_Sheet.html)
- [Auth0: Preventing Command Injection Attacks in Node.js Apps](https://auth0.com/blog/preventing-command-injection-attacks-in-node-js-apps/)

## OS Scheduling (cron / launchd / Task Scheduler)

### Overview

OpenMergeLens is designed to run on a recurring schedule via cron or launchd
on macOS/Linux, or Windows Task Scheduler on Windows. These entries are
installed programmatically by `lib/scheduler.mjs`.

### Best Practices

- Use absolute paths everywhere: the interpreter (`/usr/bin/node` or
  wherever `which node` resolves), the script itself, and any files it
  touches. Cron's default PATH (typically `/usr/bin:/bin`) doesn't source
  shell profiles, so `node`/`gh` can silently fail to resolve.
- Redirect stdout and stderr to a log file on every invocation. Append rather
  than overwrite so failures are visible across runs (cron:
  `>> poll.log 2>&1`; launchd: `StandardOutPath`/`StandardErrorPath`;
  Task Scheduler: redirect inside the wrapper script).
- Prevent overlapping runs with a lock (e.g. `flock -n /tmp/openmergelens.lock
  node bin/poll.mjs` on Unix), especially since `poll.mjs` both reads and
  writes `state.json`: an overlapping run risks a race on that file.
- Prefer launchd over cron on macOS for reliability across sleep/wake, and
  use `StartInterval` (fixed-cadence) rather than `StartCalendarInterval`
  (calendar-style fixed times) for polling-style jobs.
- Set a timeout around the actual work (e.g. `timeout 5m node
  bin/poll.mjs`) so a hung `gh` call or reviewer CLI invocation fails fast
  instead of blocking the next scheduled run.
- After editing a launchd plist, always re-run `launchctl
  bootstrap`/`bootout` (or `unload`/`load`). Launchd does not hot-reload a
  changed plist file on its own. For Task Scheduler, prefer delete-and-
  recreate over `/change` when altering the schedule itself, since
  `/Change` can't modify the trigger-defining flags (`/SC`, `/MO`, `/D`,
  `/M`).

### Common Pitfalls

- Avoid assuming cron has your interactive shell's PATH/env, because cron's
  minimal environment doesn't source `.bashrc`/profile: a script that
  works when run manually can fail silently under cron purely from a
  missing `PATH` entry.
- Avoid skipping error redirection, because an unredirected scheduler job
  fails silently: there'd be no record of why a poll didn't post a review,
  which conflicts with OpenMergeLens's own requirement that failures be visible
  (logged to `poll.log`).
- Avoid trusting `launchctl load`/`unload` as sufficient after a plist edit
  without a full reload, and avoid assuming a short `StartInterval` "just
  works" once loaded: test actual cadence after install, since some macOS
  versions have had reliability issues at certain intervals.
- Avoid ignoring the "already running" case on Windows, because schtasks'
  command-line creation doesn't reliably expose the GUI's "if already
  running" policy: use an external lock/PID check in the wrapper script
  instead of relying on scheduler defaults.

### References

- [launchd.plist(5) man page](https://keith.github.io/xcode-man-pages/launchd.plist.5.html)
- [schtasks command: Microsoft Learn](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks)
- [schtasks /change: Microsoft Learn](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-change)

---

_Last generated: 2026-07-24. Full run (no prior version existed) covering
all 6 detected stack components._
