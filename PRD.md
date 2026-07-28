# PR Review Bot — Handoff Spec

Local, agent-agnostic poller that auto-reviews GitHub PRs whenever you (antonio)
are the requested reviewer — whether that's set at PR creation or added later —
and re-reviews when new commits land after the last review. Posts results as a
PR comment automatically, no per-run approval needed.

Repo: `~/Symph/projects/pr-review-bot` (git initialized, no remote — keep it
local only unless explicitly decided otherwise later).

This doc is the full spec. Nothing has been implemented yet — pick this up in
a fresh session with: "implement the PR review bot per PRD.md".

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
  3. Needs a real review prompt, not "review this PR." Prompts are directly
     editable and shared per GitHub host/repository. Durable corrections are
     isolated per GitHub host/account/repository.
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
openmergelens/
├── PRD.md                  (this file)
├── package.json            (pnpm, type: module, bin entry)
├── pnpm-lock.yaml
├── config.example.json     (versioned multi-account config template)
├── state.json              (gitignored — per-PR last-reviewed SHA, local only)
├── docs/
│   └── review-prompt.default.md (bundled seed for editable repository prompts)
├── bin/
│   ├── poll.mjs             (one-shot poll entrypoint)
│   └── init.mjs             (interactive onboarding wizard — @clack/prompts)
├── lib/
│   ├── github.mjs           (gh CLI + REST API wrappers via child_process/fetch: search, pr view, pr diff, post review w/ inline comments)
│   ├── state.mjs            (read/write state.json)
│   ├── reviewer-adapter.mjs (abstraction over the actual review-generating command; parses structured JSON findings)
│   ├── agent-detect.mjs     (probes PATH + auth status for known reviewer CLIs: claude, codex)
│   └── scheduler.mjs        (installs cron/launchd/Task Scheduler entries, with confirm-before-write)
└── .gitignore               (state.json, node_modules, .env, any local secrets)
```

**Decided: Node, package-managed with pnpm.** Cross-OS is a hard requirement
(must work on Windows without WSL/Git Bash/Cygwin) — bash doesn't run natively
on Windows, so it's ruled out. Node runs identically on Windows/macOS/Linux;
`gh` itself is still the one external prerequisite (already required either
way, since it's the GitHub interface). pnpm used for dependency install
(likely minimal deps — maybe none beyond Node built-ins) and for exposing the
poller as a `pnpm` script / bin.

## Core logic (one poll cycle)

1. **Discover candidate PRs.** For every configured account and every
   explicitly selected repository:
   ```bash
   gh api /search/issues -f q="is:pr is:open review-requested:antonio repo:OWNER/REPO" --jq '.items[].number'
   ```
   Global search is intentionally unsupported: coverage must be explicit.
   Resolve each account with `gh auth token --hostname ... --user ...` and
   scope every child command with that credential.

2. **Review candidates in bounded concurrent batches.** Build an independent
   queue per account, deduplicate within that account, then round-robin the
   queues into one global queue. Process up to `reviewBatchSize` PRs
   concurrently across all accounts (default `5`).
   For each candidate, get the current head commit SHA:
   ```bash
   gh pr view <N> --repo OWNER/REPO --json headRefOid,number,title,url
   ```

3. **Compare against state.json**:
   - Key: `HOST@USERNAME::OWNER/REPO#N`
   - If key absent → new PR, needs review.
   - If key present and stored SHA != current `headRefOid` → new commits since
     last review, needs re-review.
   - If key present and SHA matches → skip, already reviewed this exact head.
   - If local state is missing, check the PR's submitted reviews for
     OpenMergeLens's opaque account/repo/commit marker. If found, repair local
     state and skip generation/posting. This closes the crash window between a
     successful GitHub POST and the following state write.

4. **For PRs needing review**, build the review prompt:
   - Fetch diff once for later deterministic finding-anchor validation:
     `gh pr diff <N> --repo OWNER/REPO`. Do not embed it in the reviewer prompt.
   - Fetch PR metadata (title, description, base/head branch) via `gh pr view`
   - Load the repository's user-editable prompt from
     `docs/review-prompts/<host>/<owner>/<repo>.md`. Accounts on the same host
     share it.
   - Load account-specific corrections from
     `docs/learnings/<host>/<username>/<owner>/<repo>.md`.
   - Compose a prompt roughly like:
     ```
     Perform a complete review of the linked pull request. Report every
     distinct, concrete, high-confidence issue you can substantiate. Do not
     stop after the first issue or impose an arbitrary findings limit.

     Use the structured OpenMergeLens inspection tool, backed by constrained
     host-side GitHub CLI reads, to inspect the complete cumulative PR diff and
     surrounding source. On a re-review, inspect every non-generated file and
     hunk — including code from earlier commits — as if it has not been
     reviewed before. For large PRs, inspect incrementally and maintain a
     coverage ledger instead of relying on one terminal rendering.

     Positively identify generated artifacts using repository evidence such as
     .gitattributes, generated headers, or generator configuration. Do not
     review confirmed generated output line by line; inspect its source of
     truth and validate that the tracked output is consistent. Never skip a
     file based only on its size or name.

     For each issue, output a structured entry: file, line, severity
     (critical/major/nit), and the comment text — see "Structured output
     format" below for the exact shape the adapter must return.

     ## Past learnings (adjust future reviews accordingly)
     <contents of the account/repository learnings file, if present>

     ## PR target
     <GitHub PR URL>
     ```

5. **Run independent reviewer passes** (agent-agnostic — see below) against the
   same PR URL. The reviewer receives a temporary structured MCP inspection
   tool, not the selected account credential. A parent-owned gateway validates every request
   as a GET against the fixed PR and repository before running the real `gh`
   command with the selected credential.
   The default pass set covers behavior and
   correctness, security and trust boundaries, integration and reliability,
   and tests plus an adversarial rescan. Each pass returns structured findings.
   A final synthesis invocation receives all candidate findings, independently
   checks the linked PR with `gh`, merges duplicate root causes, discards
   unsupported claims, and returns the one summary/findings result to post.
   Re-fetch metadata after review and skip posting if the head SHA changed
   during inspection. If any pass or synthesis invocation fails or returns
   malformed output, skip posting and leave state untouched so the next poll
   retries.

6. **Post the review.** **Decided: formal `gh pr review`**, not a plain
   comment — shows up in the PR's review list, not just as a comment.
   **Decided: inline, severity-tagged comments** (one of the two adopted
   design suggestions below), posted as part of the same review object via
   `gh api` (the `gh pr review` CLI subcommand doesn't support per-line
   comments directly, so use the underlying REST API for a single review
   with multiple `comments[]` entries — each anchored to `path`+`line`,
   pulled from the adapter's structured findings):
   ```bash
   gh api --method POST /repos/OWNER/REPO/pulls/<N>/reviews \
     -f event=COMMENT \
     -f body="<review summary>" \
     -f "comments[][path]=<file>" -f "comments[][line]=<line>" \
     -f "comments[][body]=[<severity>] <comment text>"
   ```
   Event type defaults to `COMMENT` (never auto-`APPROVE` or
   auto-`REQUEST_CHANGES` without the user explicitly opting into that
   later — this is a review-comment bot, not an auto-approval bot). No
   confirmation gate — auto-approved per user's decision for this flow.
   Findings the adapter couldn't anchor to a specific file/line fall back
   into the top-level review `body` (the summary), so nothing silently
   drops just because a line reference was missing. Include a deterministic,
   opaque HTML-comment marker in every review body. Retry the summary-only
   fallback only for a confirmed HTTP 422; on ambiguous transport errors,
   reconcile by listing reviews instead of issuing a second unsafe POST.

7. **If the reviewer adapter fails or returns empty** (**decided**): log the
   failure details (PR key, command, exit code/stderr) to a local log file
   and skip posting anything — no comment, no review. Leave state.json
   unchanged for that PR so it's retried on the next poll instead of being
   silently marked as reviewed.

8. **Update state.json** with the new `headRefOid` for that PR key, so the
   same commit doesn't get re-reviewed next poll.

9. **Notify after the complete poll settles.** Desktop notifications are
   default-on with a config opt-out and use native macOS, Windows, and Linux
   facilities. Emit one audible, informational-only notification when review
   work occurred or a failure needs attention; no-op and lock-contention runs
   stay silent. Identify up to three PRs by repository, number, and title,
   distinguish reviews/re-reviews/dry-runs/recoveries/tracking failures, and
   prioritize failures in mixed results. Notification delivery is
   best-effort, limited to five seconds, and can never change review state or
   the poll exit status.

## Structured output format (adopted design suggestion #1)

Prior-art research (CodeRabbit, Greptile, Bito, etc.) shows inline,
severity-tagged comments are the near-universal pattern — a single summary
comment (OpenMergeLens's original design) is lower-value than line-anchored
feedback. **Decided: adopt this.**

The reviewer adapter must return findings as JSON, not freeform prose, e.g.:

```json
{
  "summary": "One-paragraph overview of the PR and overall assessment.",
  "findings": [
    {
      "path": "src/foo.ts",
      "line": 42,
      "severity": "critical",
      "comment": "This mutates shared state without a lock — race condition under concurrent requests."
    }
  ]
}
```

Severity levels: `critical` (bug/security, blocks merge), `major` (real
issue, should fix), `nit` (style/minor, optional). The reviewer-adapter
prompt must instruct the backend to emit exactly this shape (e.g. "respond
with JSON only, matching this schema: ..."); `lib/reviewer-adapter.mjs`
parses and validates it, falling back to treating the whole response as an
unanchored `summary` finding if parsing fails (rather than failing the poll
outright — degrade gracefully to a summary-only review).

## Learnings file (adopted design suggestion #2)

Prior-art research shows tools like CodeRabbit let reviewers reject/accept
AI suggestions, and that feedback shapes future reviews — reducing repeat
false positives. **Decided: adopt a lightweight local equivalent.**

- `docs/learnings/<host>/<username>/<owner>/<repo>.md`: a free-form markdown
  file of durable notes ("don't flag X, it's intentional because Y"). The
  deterministic path prevents corrections learned for one reviewer identity
  or repository from contaminating another.
- Not auto-written by OpenMergeLens itself in v1 — the user manually appends
  entries after noticing the bot repeat a bad suggestion. (Auto-capturing
  "user reacted 👎 to this comment" would require polling PR comment
  reactions, which is a reasonable future enhancement but out of scope for
  the initial implementation.)
- Loaded and inlined into every review prompt per step 4 above, so it
  compounds over time without any code change — just editing a markdown
  file.

## Agent-agnostic reviewer adapter

Don't hardcode `claude -p ...`. Instead, define a config field like:

```json
{
  "reviewerCommand": "claude -p --output-format text",
  "reviewerInputMode": "stdin"
}
```

The adapter script pipes the composed PR-link prompt to `reviewerCommand` via stdin (or
substitutes a `{prompt_file}` placeholder if the backend needs a file path
instead of stdin) and captures stdout as the review text. This way, swapping
to a different CLI (another agent runtime, a different model wrapper, a local
LLM harness) is a one-line config change, not a code change.

Suggested default for `reviewerCommand`: `claude -p` reading the prompt from
stdin, since that matches how the user already works — but keep it swappable.

## Config shape

```json
{
  "configVersion": 2,
  "githubAccounts": [
    {
      "hostname": "github.com",
      "username": "work-account",
      "repositories": ["OWNER/socialpostai-v2"]
    },
    {
      "hostname": "github.com",
      "username": "personal-account",
      "repositories": ["OWNER/personal-project"]
    }
  ],
  "reviewerCommand": "claude -p",
  "reviewBatchSize": 5,
  "reviewFocusCount": 4,
  "stateFile": "./state.json"
}
```

**Decided: repo name is `suguspnk/openmergelens`** for this bot's own repo (not
to be confused with `socialpostai-v2`, which is what it watches/reviews).
Repository targets are always explicit `OWNER/REPO` strings.

## State file shape (gitignored, local only)

```json
{
  "github.com@antonio::OWNER/socialpostai-v2#123": {
    "lastReviewedSha": "abc123...",
    "lastReviewedAt": "2026-07-24T18:00:00Z"
  }
}
```

## Scheduling

`node bin/poll.mjs` remains a one-shot script — no built-in daemon/loop
mode. **Decided: the `openmergelens init` wizard installs the schedule**, not a
manual next-session step — see **Onboarding** below for the exact flow
(cron / launchd / Task Scheduler, each with a confirm-before-write, or
"I'll do it myself" which only prints instructions). This section covers
what each option actually installs:
- `cron` entry (macOS/Linux) running `node bin/poll.mjs` every N minutes
- `launchd` plist (more idiomatic on macOS, survives reboots better than cron)
- Windows Task Scheduler entry running `node bin/poll.mjs`
- Claude Code's `/loop` skill wrapping a shell invocation remains a manual
  option outside the wizard, if the user wants to drive it from inside a
  Claude Code session instead of OS-level scheduling

## Auth prerequisites

- `gh auth status` must show an authenticated account with `repo` scope
  (needed for `pr comment`, `pr view`, `pr diff` on private repos).
- Whatever `reviewerCommand` is configured must have its own auth already
  set up independently (e.g. `claude` CLI already logged in). The onboarding
  wizard (below) checks this at setup time so auth problems surface before
  the first poll, not silently as a failed/skipped review later.

## Onboarding (`openmergelens init`)

**Decided: an interactive setup wizard**, not a hand-edited config file.
Modeled on well-known CLI onboarding flows (`gh auth login`, `npm init`,
`create-next-app`, `stripe login`): short prompts, sensible defaults,
inline validation, ends in a real test run rather than a wall of docs.

**Library: `@clack/prompts`** — modern, cancel-safe (Ctrl-C cleanly aborts
mid-flow without leaving a half-written config), good default look
(rounded borders/spinners) without needing custom styling work.

Command: `pnpm dlx openmergelens init` (or `node bin/init.mjs` if run from a
cloned checkout). Steps, in order:

1. **Welcome banner.** One line — name + one-sentence purpose. No ASCII art.

2. **GitHub reviewer account selection.** Runs `gh auth status`, lists every
   authenticated account, and asks for the complete set that should search
   for review requests and post reviews. Existing configured accounts are
   preselected.
   - No authenticated accounts → print the exact fix (`gh auth login`) and
     exit immediately.
   - Store only hostnames, usernames, and explicit repositories in config,
     never tokens.
   - Config version 2 is a clean break; legacy config shapes are rejected and
     are not migrated.
   - Resolve each account at poll time with
     `gh auth token --hostname ... --user ...` and pass the token only to
     child `gh` processes. Do not use
     `gh auth switch`, because it mutates global CLI state and races with
     other scheduled OpenMergeLens instances.

3. **Repository selection — explicit per account.** No global mode:
   - For each selected account, fetch every accessible repository:
     `gh repo list --json nameWithOwner,isPrivate --limit 200` (paginate if
     needed).
   - Render a searchable multi-select with existing repository choices
     preselected. Require at least one repository per account.

4. **Review files — deterministic and previewed.** Seed one prompt per
   host/repository and one empty learnings file per host/account/repository,
   but only after the final confirmation. Never overwrite existing files.

5. **Reviewer backend — detect known agent CLIs, offer custom as always
   available.**
   - Probe for known CLIs on `PATH` and check each is actually
     authenticated/working, not just installed:
     - **Claude Code** (`claude`): detect via `which claude`; verify
       working with a minimal non-mutating check (e.g. `claude -p "ok"
       --output-format text` or equivalent lightweight ping) rather than
       assuming presence-on-PATH means ready.
     - **Codex CLI** (`codex`): detect via `which codex`; verify similarly
       with a prompt-only-safe check (`codex exec --skip-git-repo-check
       --ephemeral --sandbox read-only "ok"` or its equivalent). The
     generated reviewer command uses the same flags plus access to only the
     per-review local GitHub gateway, so scheduled execution
       does not depend on a Git working directory, does not retain five
       sessions per reviewed PR, and prevents model-generated commands from
       modifying local files.
   - Multi-select-style list showing each detected CLI with a status
     badge: `✓ ready`, `✗ found but not authenticated`, or not listed at
     all if not found on PATH. An entry marked "found but not
     authenticated" is still selectable — picking it prints the specific
     login command for that CLI (e.g. `claude /login`, `codex login`) and
     tells the user to run it, **then** re-checks before continuing, so
     auth happens right where the wizard flags it's missing, not as a
     mystery failure during the first poll.
   - **Custom command** option always shown regardless of detection
     results — free-text entry for `reviewerCommand` (any other CLI/script
     the adapter can shell out to). It must expose the per-review MCP server
     through explicit `{{mcp_config}}` and `{{mcp_tool}}` placeholders;
     commands without both placeholders fail closed before launch.
   - Selection sets `reviewerCommand` (and `reviewerInputMode`) in config.
   - Config loading upgrades the exact former generated defaults (`codex exec`
     and the earlier read-only/no-network Codex command) to the safe
     read-only-filesystem, local-gateway command above. Commands already
     customized by the user are never rewritten.

6. **Review focus coverage.** Ask how many independent review focus
   categories to run before synthesis:
   - 4 — behavior/correctness, security/trust boundaries,
     integration/reliability, and tests/adversarial rescan (recommended)
   - 3, 2, or 1 — progressively fewer categories and fewer reviewer calls
   The selection sets `reviewFocusCount` and the final config preview explains
   the resulting reviewer-call count. On rerun, default to the existing value
   when it is valid.

7. **Scheduling.** Select one:
   - `cron` (macOS/Linux)
   - `launchd` (macOS, preferred over cron — survives reboots better)
   - Windows Task Scheduler
   - "I'll do it myself" — prints the equivalent manual snippet/steps for
     whichever platform the user is on and does nothing further.

   **Decided: for the first three, OpenMergeLens installs the entry itself**
   (writes the crontab line / launchd plist + `launchctl load` / Task
   Scheduler entry) — not just instructions. But because this is a
   standing OS-level configuration change made on the user's behalf, the
   wizard must show the **exact entry it's about to write** (full crontab
   line, full plist contents, or full `schtasks` command) and get an
   explicit final yes/no at that step, immediately before writing —
   picking "cron" earlier in the menu is not itself the confirmation.
   "I'll do it myself" skips this entirely; nothing is written to the OS.

8. **Summary + confirm.** Preview config, deterministic review-file paths,
   and the one shared schedule. Ask once before applying file/config/schedule
   writes. If the user declines, leave configuration and review files
   unchanged.

9. **Success screen.** Print the command to do a complete dry run and an
   account-filtered example using `--account USERNAME@HOSTNAME`, e.g.
   `node bin/poll.mjs --dry-run` (composes prompts and calls the reviewer
   adapter, but skips the actual `gh pr review` post) — onboarding ends at
   "see it produce real output," not "trust it blindly."

Validation happens inline at each step (e.g. repo names checked live via
the `gh repo list` fetch in step 3, not deferred to a final check), so a
mistake is caught where it's made rather than surfacing as a cryptic
failure three steps later.

## Decisions (resolved)

All open items from spec drafting are now resolved:

1. **Language: Node, managed with pnpm.** Bash was ruled out — it doesn't run
   natively on Windows, and cross-OS support (no WSL/Git Bash requirement) is
   a hard requirement. Node runs identically on all three OSes.
2. **Bot repo name: `suguspnk/openmergelens`.** Still need the actual
   `OWNER/socialpostai-v2` slug for the *watched* repo — check `git remote -v`
   there at implementation time.
3. **Search scope: explicit per account.** Global search is unsupported.
4. **Error handling:** log failure details, skip posting, leave state
   unchanged so it retries next poll.
5. **Post format: formal `gh pr review`**, not a plain `gh pr comment` —
   visible in the PR's review list. **Refined further per prior-art
   research:** inline, severity-tagged comments (via the REST API's
   `comments[]`, since `gh pr review` CLI can't anchor per-line), not a
   single review body — see **Structured output format** above.
6. **Prompt source: OpenMergeLens's own bundled template**, seeded into a
   directly editable host/repository prompt path.
7. **Prior-art research done** (competitive scan of CodeRabbit, Qodo/PR-Agent,
   Sourcery, DeepSource, Greptile, Hermes Agent, etc. — see conversation
   history). Confirmed no existing product does local-polling +
   no-GitHub-App + BYO-LLM the way OpenMergeLens does; two design patterns
   adopted from the scan:
   - **Inline, severity-tagged comments** instead of a single summary
     comment (near-universal pattern across commercial tools).
   - **Account/repository learning files** are inlined only into that
     identity's prompt, so corrections compound without cross-account
     contamination.
8. **Onboarding UX designed** (`openmergelens init`, see full section above):
   interactive wizard using `@clack/prompts`. Key resolved sub-decisions:
   - GitHub account selection is a multi-select; every selected identity owns
     an independent explicit repository list.
   - Repo selection is a searchable multi-select of accessible repos for each
     account, with no global mode.
   - Reviewer-backend step **detects known agent CLIs** (Claude Code,
     Codex) on PATH and **checks each is actually authenticated**, not
     just installed — surfacing the specific login command inline if not.
     A free-text **custom command** option is always available alongside
     detected CLIs.
   - Scheduling: wizard **installs** the cron/launchd/Task Scheduler entry
     itself (not just instructions) for those three options, but shows the
     exact entry and requires a final explicit confirm immediately before
     writing it, since it's a standing OS-level change. "I'll do it
     myself" only ever prints instructions, no OS write.
   - Prompt/learnings paths are deterministic rather than configurable:
     prompts are shared per host/repository and learnings are isolated per
     host/account/repository.

## Multi-account operational decisions

- One account's auth failure never blocks healthy accounts; account,
  repository, and candidate failures are logged and make the final exit
  nonzero after independent work completes.
- The same PR can be reviewed independently by multiple requested identities.
- One shared state file uses hostname/username-namespaced keys.
- One global `reviewBatchSize` is enforced across a round-robin account queue.
- One process lock prevents overlapping polls and blocks `init` while polling.
- Removing an account or repository stops polling it but retains its prompt,
  learnings, and state for safe reactivation.
