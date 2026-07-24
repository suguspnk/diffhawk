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
  3. Needs a real review prompt, not "review this PR" — **decided: write a
     new checklist from scratch, owned by diffhawk itself** (not borrowed
     from `socialpostai-v2` or any watched repo — keeps diffhawk's own
     standards independent of any one project's docs). Default location:
     `diffhawk/docs/checklist.md`. "Configurable" means **directly
     editable** — just open and edit `docs/checklist.md`, no wizard/UI
     needed for routine changes. `checklistPath` in config exists on top of
     that for the less common case of pointing a specific watched repo at
     a wholly different checklist file.
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
diffhawk/
├── PRD.md                  (this file)
├── package.json            (pnpm, type: module, bin entry)
├── pnpm-lock.yaml
├── config.json             (repos to watch, reviewer username, checklist paths)
├── state.json              (gitignored — per-PR last-reviewed SHA, local only)
├── docs/
│   ├── checklist.md          (diffhawk's own default review checklist)
│   └── learnings.md          (optional, user-maintained — durable review notes/corrections)
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

1. **Discover candidate PRs.** **Decided: configurable**, not hardcoded either
   way — `config.json` supports both modes:
   ```bash
   gh api /search/issues -f q="is:pr is:open review-requested:antonio repo:OWNER/REPO" --jq '.items[].number'
   ```
   Run once per repo listed under `pollTargets` for per-repo scoping, or set
   a top-level `"searchScope": "global"` (omit `repo:` from the query) to
   cover every repo the user has access to from one config entry. Default to
   per-repo (explicit, predictable) unless global is set.

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
   - Load the checklist doc from `checklistPath` (defaults to diffhawk's own
     `docs/checklist.md`; overridable per-repo in config) and inline it into
     the prompt as review criteria.
   - Load `docs/learnings.md` (or repo-configured `learningsPath`) if present
     and inline it too — see **Learnings file** below.
   - Compose a prompt roughly like:
     ```
     Review this pull request diff against the checklist below. Report
     concrete, high-confidence issues only (bugs, security, correctness,
     violations of established repo conventions). Cite file:line. Be direct,
     no preamble.

     For each issue, output a structured entry: file, line, severity
     (critical/major/nit), and the comment text — see "Structured output
     format" below for the exact shape the adapter must return.

     ## Checklist
     <contents of docs/checklist.md or repo-configured checklistPath>

     ## Past learnings (adjust future reviews accordingly)
     <contents of docs/learnings.md, if present>

     ## PR: <title> (#<N>)
     <description>

     ## Diff
     <diff>
     ```

5. **Invoke the reviewer adapter** (agent-agnostic — see below) with that
   prompt, capture its output as structured findings (see **Structured output
   format** below), not just raw text.

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
   drops just because a line reference was missing.

7. **If the reviewer adapter fails or returns empty** (**decided**): log the
   failure details (PR key, command, exit code/stderr) to a local log file
   and skip posting anything — no comment, no review. Leave state.json
   unchanged for that PR so it's retried on the next poll instead of being
   silently marked as reviewed.

8. **Update state.json** with the new `headRefOid` for that PR key, so the
   same commit doesn't get re-reviewed next poll.

## Structured output format (adopted design suggestion #1)

Prior-art research (CodeRabbit, Greptile, Bito, etc.) shows inline,
severity-tagged comments are the near-universal pattern — a single summary
comment (diffhawk's original design) is lower-value than line-anchored
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

- `docs/learnings.md` (default) or repo-configured `learningsPath`: a
  free-form markdown file of durable notes ("don't flag X, it's
  intentional because Y", "this repo always does Z, not the checklist's
  default recommendation"). "Configurable" here means **directly editable**
  — the user opens the file and edits it, there's no wizard/UI for it.
- Not auto-written by diffhawk itself in v1 — the user manually appends
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
      "checklistPath": "/absolute/path/to/diffhawk/docs/checklist.md",
      "learningsPath": "/absolute/path/to/diffhawk/docs/learnings.md"
    }
  ],
  "reviewerCommand": "claude -p",
  "stateFile": "./state.json"
}
```

**Decided: repo name is `suguspnk/diffhawk`** for this bot's own repo (not
to be confused with `socialpostai-v2`, which is what it watches/reviews).
Confirm the actual `OWNER/socialpostai-v2` slug (check `git remote -v` in that
repo) before wiring up `pollTargets` at implementation time.

## State file shape (gitignored, local only)

```json
{
  "OWNER/socialpostai-v2#123": {
    "lastReviewedSha": "abc123...",
    "lastReviewedAt": "2026-07-24T18:00:00Z"
  }
}
```

## Scheduling

`node bin/poll.mjs` remains a one-shot script — no built-in daemon/loop
mode. **Decided: the `diffhawk init` wizard installs the schedule**, not a
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

## Onboarding (`diffhawk init`)

**Decided: an interactive setup wizard**, not a hand-edited config file.
Modeled on well-known CLI onboarding flows (`gh auth login`, `npm init`,
`create-next-app`, `stripe login`): short prompts, sensible defaults,
inline validation, ends in a real test run rather than a wall of docs.

**Library: `@clack/prompts`** — modern, cancel-safe (Ctrl-C cleanly aborts
mid-flow without leaving a half-written config), good default look
(rounded borders/spinners) without needing custom styling work.

Command: `pnpm dlx diffhawk init` (or `node bin/init.mjs` if run from a
cloned checkout). Steps, in order:

1. **Welcome banner.** One line — name + one-sentence purpose. No ASCII art.

2. **GitHub auth check** (automatic, not a prompt). Runs `gh auth status`
   silently.
   - Pass → continue, pre-fill username from `gh api user --jq .login`.
   - Fail → print the exact fix (`gh auth login`) and exit immediately.
     Never prompts for a token directly (this bot never handles credentials
     itself — it only ever shells out to an already-authenticated `gh`).

3. **Repo selection — decided: checklist, not a mode toggle.** No
   "one repo vs. all repos" branch. Instead:
   - Fetch every repo the user has access to:
     `gh repo list --json nameWithOwner,isPrivate --limit 200` (paginate if
     needed).
   - Render as a multi-select checklist (`@clack/prompts` `multiselect`),
     searchable/filterable by typing, nothing pre-checked.
   - Selected repos become the `pollTargets` entries. This replaces the
     earlier "global search scope" idea as the *onboarding default* — the
     `searchScope: "global"` config option (see Decisions, item 3) still
     exists for advanced/manual config editing, but the wizard itself
     always resolves to an explicit repo list so the user always knows
     exactly what's being watched.

4. **Checklist step — decided: informational, not a fork.** Every
   `pollTargets` entry gets the same default `checklistPath`
   (`docs/checklist.md`); there's no per-repo "custom vs default" prompt
   during onboarding (that already exists as a manually-edited config
   option — see `checklistPath` in Config shape). The wizard just prints
   one line: *"Review checklist: docs/checklist.md — edit this file
   anytime to change what diffhawk looks for, no need to rerun setup."*
   Same one-line treatment for `docs/learnings.md`.

5. **Reviewer backend — detect known agent CLIs, offer custom as always
   available.**
   - Probe for known CLIs on `PATH` and check each is actually
     authenticated/working, not just installed:
     - **Claude Code** (`claude`): detect via `which claude`; verify
       working with a minimal non-mutating check (e.g. `claude -p "ok"
       --output-format text` or equivalent lightweight ping) rather than
       assuming presence-on-PATH means ready.
     - **Codex CLI** (`codex`): detect via `which codex`; verify similarly
       (`codex exec "ok"` or its equivalent minimal check).
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
     the adapter can shell out to).
   - Selection sets `reviewerCommand` (and `reviewerInputMode`) in config.

6. **Scheduling.** Select one:
   - `cron` (macOS/Linux)
   - `launchd` (macOS, preferred over cron — survives reboots better)
   - Windows Task Scheduler
   - "I'll do it myself" — prints the equivalent manual snippet/steps for
     whichever platform the user is on and does nothing further.

   **Decided: for the first three, diffhawk installs the entry itself**
   (writes the crontab line / launchd plist + `launchctl load` / Task
   Scheduler entry) — not just instructions. But because this is a
   standing OS-level configuration change made on the user's behalf, the
   wizard must show the **exact entry it's about to write** (full crontab
   line, full plist contents, or full `schtasks` command) and get an
   explicit final yes/no at that step, immediately before writing —
   picking "cron" earlier in the menu is not itself the confirmation.
   "I'll do it myself" skips this entirely; nothing is written to the OS.

7. **Summary + confirm.** Render the resulting config as a compact table
   (repos, checklist path, reviewer command, schedule) and ask for a final
   y/n before writing `config.json`. If the user declines, exit without
   writing anything (re-running `init` starts clean, doesn't merge/patch a
   partial file).

8. **Success screen.** Print the one command to do a real dry run, e.g.
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
2. **Bot repo name: `suguspnk/diffhawk`.** Still need the actual
   `OWNER/socialpostai-v2` slug for the *watched* repo — check `git remote -v`
   there at implementation time.
3. **Search scope: configurable**, per-repo (default) or global via
   `"searchScope": "global"` in config.
4. **Error handling:** log failure details, skip posting, leave state
   unchanged so it retries next poll.
5. **Post format: formal `gh pr review`**, not a plain `gh pr comment` —
   visible in the PR's review list. **Refined further per prior-art
   research:** inline, severity-tagged comments (via the REST API's
   `comments[]`, since `gh pr review` CLI can't anchor per-line), not a
   single review body — see **Structured output format** above.
6. **Checklist source: diffhawk's own**, written from scratch at
   `docs/checklist.md` — not borrowed from `socialpostai-v2` or any watched
   repo. Configurable per-repo via `checklistPath` so it can be overridden
   once deployed.
7. **Prior-art research done** (competitive scan of CodeRabbit, Qodo/PR-Agent,
   Sourcery, DeepSource, Greptile, Hermes Agent, etc. — see conversation
   history). Confirmed no existing product does local-polling +
   no-GitHub-App + BYO-LLM the way diffhawk does; two design patterns
   adopted from the scan:
   - **Inline, severity-tagged comments** instead of a single summary
     comment (near-universal pattern across commercial tools).
   - **A `docs/learnings.md` file** inlined into every prompt, so
     user-corrected mistakes don't repeat (lightweight local analog to
     CodeRabbit's "learnings" feature).
8. **Onboarding UX designed** (`diffhawk init`, see full section above):
   interactive wizard using `@clack/prompts`. Key resolved sub-decisions:
   - Repo selection is a **multi-select checklist of all accessible repos**
     (`gh repo list`), not a "one repo vs. all repos" mode toggle.
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
   - Checklist/learnings paths are **not** a per-repo wizard prompt — they
     default the same for every repo and are meant to be edited directly
     as plain files after setup, not reconfigured through the wizard.

## Open items for the next session

1. Write `docs/checklist.md` (diffhawk's own review checklist — content not
   yet drafted). `docs/learnings.md` can start empty/absent — it's meant to
   accumulate over time, not be pre-populated.
2. Implement `bin/init.mjs` per the Onboarding section — scheduling install
   (cron/launchd/Task Scheduler) happens there now, not as a separate
   manual step.
