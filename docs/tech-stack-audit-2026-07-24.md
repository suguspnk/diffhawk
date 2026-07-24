# Implementation Audit vs. Tech Stack Standards

Audit date: 2026-07-24. Compares the current implementation (`bin/`, `lib/`)
against [docs/tech-stack-standards.md](tech-stack-standards.md). Findings are
grouped by component, ranked by severity within each.

## Summary

The implementation follows the two highest-stakes standards well: `execFile`/
`spawn(shell:false)` discipline is consistent everywhere, and the
diff-anchoring / fallback-on-422 logic in `postReview` is more careful than
the standards doc even asked for. The gaps are mostly in operational
hardening (unattended-run robustness, pagination, concurrency safety) rather
than the security-critical injection surface.

| Component | Status |
|---|---|
| Shell/Command Injection Avoidance | ✅ Fully compliant |
| Node.js (ESM + child_process) | ✅ Compliant, one soft gap (engines enforcement) |
| GitHub CLI (`gh`) | ⚠️ Gaps: pagination, auth mode, rate-limit handling |
| @clack/prompts | ⚠️ Gap: no TTY guard |
| OS Scheduling | ⚠️ Gaps: no overlap lock, no timeout wrapper |
| pnpm | ⚠️ Gap: no `engineStrict` |

## Shell/Command Injection Avoidance — ✅ Fully compliant

- Every shell-out uses `execFile` or `spawn(..., { shell: false })`, never
  `exec`: [`lib/github.mjs:10`](../lib/github.mjs), [`lib/scheduler.mjs`](../lib/scheduler.mjs)
  (`execFileAsync` throughout), [`lib/reviewer-adapter.mjs:59`](../lib/reviewer-adapter.mjs).
- Untrusted content (diff text, PR body, reviewer command output) is passed
  as discrete argv elements or via stdin, never string-concatenated into a
  command line — e.g. `postReview` sends the JSON payload via
  `--input -` + `{ input: ... }` ([`lib/github.mjs:177-180`](../lib/github.mjs)),
  and `invokeReviewer` writes the prompt to `child.stdin` rather than argv
  ([`lib/reviewer-adapter.mjs:76`](../lib/reviewer-adapter.mjs)).
- The user-configured `reviewerCommand` is tokenized into `{cmd, args}` and
  spawned with `shell: false` — matches the standard's explicit guidance that
  a configurable command string must still be split into an argv array, not
  interpolated ([`lib/reviewer-adapter.mjs:45-59`](../lib/reviewer-adapter.mjs)).
- No allowlist/pattern validation on `repo` or `number` before they reach
  argv (e.g. in `getPullRequest`, `postReview`). This is a minor residual
  risk per the standard's "argument/flag injection" pitfall — a `repo` value
  starting with `-` could theoretically be misread as a flag by `gh`. Low
  severity here since `repo`/`number` originate from `gh api`'s own JSON
  response, not directly from a PR author, but worth a defensive check if
  `config.json`'s `pollTargets[].repo` is ever taken from a less trusted
  source.

## Node.js (ESM + child_process) — ✅ Compliant, one soft gap

- `"type": "module"` used consistently; `"engines": { "node": ">=18" }`
  declared in [`package.json`](../package.json) — matches the standard.
- `execFile`/`spawn` used everywhere `child_process` appears; no instance of
  `exec`, `execSync`, or `shell: true` found anywhere in `bin/` or `lib/`.
- **Gap:** `engines` is declared but not enforced (`engineStrict` is not set
  anywhere — no `.npmrc` exists in the repo). Per the standard, this means
  the field is advisory only; someone running diffhawk under Node 16 gets a
  warning, not a hard failure, and could hit subtle runtime issues
  (`node:child_process` `timeout` option behavior, ESM interop) without a
  clear error pointing at the real cause.

## @clack/prompts — ⚠️ One gap

- `isCancel()` is checked after every prompt in [`bin/init.mjs`](../bin/init.mjs)
  (`selectedRepos`, `backendChoice`, `custom`, `scheduleChoice`, `interval`,
  `confirmInstall`, `confirmWrite`), each routing to `exitCancelled()` —
  matches the standard's top practice.
- `spinner()` wraps the repo-fetch and reviewer-CLI-detection calls
  ([`bin/init.mjs:38-41`](../bin/init.mjs), `62-65`), giving feedback during
  slow network calls as recommended.
- `validate()` is used on the custom-command and interval text prompts
  ([`bin/init.mjs:92`](../bin/init.mjs), `123`) to reject empty/malformed
  input inline.
- **Gap:** No TTY check anywhere in `init.mjs` before entering the
  interactive wizard. The standard specifically calls out guarding
  interactive-prompt code behind `process.stdin.isTTY` with a non-interactive
  fallback, since piped-stdin/CI contexts can hang. This is lower risk here
  since `init.mjs` is explicitly a one-time interactive setup step (unlike
  `poll.mjs`, which is designed to run unattended and has no `@clack/prompts`
  usage at all) — but if `init.mjs` is ever invoked from a non-interactive
  wrapper (e.g. a first-run auto-setup triggered from `poll.mjs`), it would
  hang indefinitely with no diagnostic.
- Not an issue found: no evidence of the custom-filter-on-autocomplete
  double-filtering pitfall — `autocompleteMultiselect`'s `options` are passed
  unfiltered and unsorted ([`bin/init.mjs:52-56`](../bin/init.mjs)), so
  clack's built-in filter is the only filter in play.

## GitHub CLI (`gh`) — ⚠️ Three gaps

- Structured output via `--json`/`--jq` is used consistently — no
  human-readable text parsing anywhere ([`lib/github.mjs`](../lib/github.mjs),
  every `gh` call).
- `--method GET` is correctly forced on `/search/issues` and `user/repos`
  calls, with an inline comment explaining *why* (`-f` defaults to POST body)
  — shows awareness of a real `gh api` gotcha the standards doc didn't even
  call out.
- **Gap — no `--paginate` on the PR search itself.** `listAccessibleRepos`
  correctly uses `--paginate` ([`lib/github.mjs:42`](../lib/github.mjs)), but
  `searchReviewRequestedPRs` — the actual "find PRs awaiting my review" call
  against `/search/issues` — does not
  ([`lib/github.mjs:65-68`](../lib/github.mjs)). Per the standard, `gh api`
  search/list calls silently truncate to the first page without
  `--paginate`. In practice `/search/issues` caps at 100 items/page and this
  bot's use case (PRs where the user is a requested reviewer) is unlikely to
  exceed one page for most users, but it's an inconsistency worth fixing or
  at minimum documenting as an accepted limit.
- **Gap — no explicit `GH_TOKEN`/unattended-auth handling.** The standard
  recommends authenticating via `GH_TOKEN`/`GITHUB_TOKEN` env var rather than
  relying on ambient `gh auth login` state for unattended/scheduled
  contexts, partly because `gh api` can silently fall back to unauthenticated
  requests if keychain-based credential resolution fails (a documented macOS
  issue). `checkAuth()` ([`lib/github.mjs:21-28`](../lib/github.mjs)) only
  checks auth status once, during `init.mjs`'s interactive setup — `poll.mjs`
  never re-verifies auth before its unattended run, so a keychain hiccup on
  a scheduled run would surface as a confusing downstream 401/403 in
  `poll.log` rather than a clear "not authenticated" message.
- **Gap — no rate-limit awareness or write-call backoff.** No call to
  `gh api rate_limit` and no spacing between successive `postReview` calls
  in `poll.mjs`'s per-PR loop. Low risk at typical personal-use polling
  volumes (a handful of PRs every 15 minutes), but the standard flags this
  because GitHub's secondary/abuse rate limiting throttles burst write
  patterns independently of the hourly quota — a poll cycle that finds many
  PRs needing review at once could hit it.
- **Gap — no use of `gh help exit-codes`-style differentiation.** `gh()`'s
  error handling ([`lib/github.mjs:15-18`](../lib/github.mjs)) collapses
  every failure into one generic `Error` with stderr text, rather than
  distinguishing auth failure / not-found / network error by exit code. This
  makes `poll.log` entries harder to triage at a glance (e.g. "PR not found"
  vs. "GitHub API down" both look like generic failures).

## pnpm — ⚠️ One gap

- `pnpm-lock.yaml` is committed at the repo root, matching the standard.
- No use of global tool installs anywhere in scripts/docs; the standard's
  `dlx` guidance isn't directly applicable since diffhawk itself is the
  installed tool, not a consumer of ad-hoc CLI tools.
- **Gap:** no `.npmrc` with `engine-strict=true`, and no `pnpm.onlyBuiltDependencies`
  field in `package.json`. Given the single runtime dependency
  (`@clack/prompts`) this is low-impact today, but combined with the
  Node.js `engines`-enforcement gap above, means neither the Node version
  nor the pnpm version is actually gated at install time.

## OS Scheduling (cron / launchd / Task Scheduler) — ⚠️ Two gaps

- Absolute paths used throughout: `process.execPath` for the Node binary,
  resolved absolute `pollScriptPath` — matches the standard's top practice
  ([`lib/scheduler.mjs:11-13`](../lib/scheduler.mjs)).
- stdout/stderr redirection is wired for all three backends: cron's
  `>> poll.log 2>&1` ([`lib/scheduler.mjs:16`](../lib/scheduler.mjs)),
  launchd's `StandardOutPath`/`StandardErrorPath` plist keys (`54-57`), and
  `poll.mjs`'s own `poll.log` append-based failure logging
  ([`bin/poll.mjs:32-36`](../bin/poll.mjs)) is a second layer on top of
  whatever the scheduler captures.
- `StartInterval` (not `StartCalendarInterval`) is correctly used for
  launchd's fixed-cadence polling behavior
  ([`lib/scheduler.mjs:52-53`](../lib/scheduler.mjs)), matching the standard
  exactly.
- `installLaunchd` reloads via `unload` then `load` after writing the plist
  ([`lib/scheduler.mjs:68-73`](../lib/scheduler.mjs)) — matches the standard's
  "always reload after editing a plist" guidance.
- **Gap — no overlap protection.** Nothing in `poll.mjs`, `installCron`,
  `installLaunchd`, or `installSchtasks` uses a lock file (`flock` or
  equivalent) to prevent two overlapping poll runs. This is the standard's
  most concrete, diffhawk-specific pitfall: `state.json` is read at the top
  of `main()` and written at the end of each successful review
  ([`bin/poll.mjs:44`](../bin/poll.mjs), `142`), so two overlapping runs
  (e.g. a slow reviewer-CLI invocation causing one run to still be in flight
  when the next scheduled tick fires) can race on `loadState`/`saveState`
  and silently lose a state update — a scenario the standards doc calls out
  by name for this exact read/write pattern.
- **Gap — no timeout wrapper at the OS-invocation level.** `invokeReviewer`
  does have its own internal `timeoutMs` (default 5 minutes,
  [`lib/reviewer-adapter.mjs:55`](../lib/reviewer-adapter.mjs)), which
  covers the single riskiest long-running call. But there's no outer
  `timeout` wrapper (or equivalent) around the whole `poll.mjs` invocation
  in any of the generated cron lines, plist, or schtasks command — if `gh`
  itself hangs (e.g. a network stall not covered by `execFileAsync`'s
  default no-timeout behavior in `lib/github.mjs`), nothing bounds that call,
  which feeds back into the overlap risk above.

## Recommended priority order

1. **Add a lock file around `poll.mjs`'s `main()`** (e.g. an
   `flock`-equivalent using `proper-lockfile` or a simple PID-file check at
   the top of `bin/poll.mjs`) — this is the one gap that can cause silent,
   hard-to-diagnose state corruption, and it's specific to diffhawk's actual
   read-then-write pattern, not a generic hardening suggestion.
2. **Add `--paginate` to `searchReviewRequestedPRs`** for consistency with
   `listAccessibleRepos` and correctness if a user is ever requested-reviewer
   on 100+ open PRs at once.
3. **Wrap `gh` calls in `lib/github.mjs` with an explicit timeout** (the
   `execFileAsync` calls there currently have no `timeout` option, unlike
   `agent-detect.mjs`'s calls), so a network stall can't hang a scheduled
   run indefinitely.
4. Everything else (engine-strict enforcement, TTY guard on `init.mjs`,
   `GH_TOKEN` documentation, rate-limit backoff, exit-code differentiation)
   is lower-severity operational polish, worth doing but not urgent for a
   single-user local tool.
