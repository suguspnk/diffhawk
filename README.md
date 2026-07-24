# diffhawk

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
2. **pnpm**
   ```bash
   pnpm --version
   ```
   If it's missing: `npm install -g pnpm`
3. **GitHub CLI (`gh`), authenticated**
   ```bash
   gh auth status
   ```
   If this fails, run `gh auth login` first — diffhawk never handles your
   GitHub credentials directly, it only ever calls `gh`.
4. **A reviewer CLI**, already logged in on its own — pick one:
   - [Claude Code](https://claude.com/claude-code): `claude /login`
   - [Codex CLI](https://github.com/openai/codex): `codex login`
   - Anything else that can read a prompt from stdin and print text/JSON to
     stdout.

## Install

```bash
pnpm install
```

## Set up (interactive wizard)

```bash
node bin/init.mjs
```

This will:
1. Verify `gh` is authenticated (exits with instructions if not).
2. Show every repo you have access to — your own, plus any org or
   collaborator repos — as a type-to-filter, multi-select list (handy if
   that's hundreds or thousands of repos). Select the ones you want
   diffhawk to watch.
3. Print where the default checklist (`docs/checklist.md`) and learnings file
   (`docs/learnings.md`) live — edit those anytime, no need to rerun setup.
4. Detect Claude Code / Codex on your `PATH` and check whether each is
   actually authenticated (not just installed). You can also enter a custom
   reviewer command instead.
5. Offer to install a schedule (cron, launchd on macOS, or Windows Task
   Scheduler) — it shows you the **exact** entry before writing anything and
   asks for confirmation. You can also choose "I'll do it myself" to just get
   the instructions.
6. Show you the final config and ask before writing `config.json`.

Nothing is written to your system or to GitHub without an explicit
confirmation at each step.

### Setting up by hand instead

If you'd rather skip the wizard, copy [config.example.json](./config.example.json)
to `config.json` and fill in the fields yourself:

```bash
cp config.example.json config.json
```

| Field | Meaning |
|---|---|
| `githubUsername` | Your GitHub username — used to search for `review-requested:<username>`. |
| `searchScope` | `"per-repo"` (default) to only watch `pollTargets`, or `"global"` to search every repo you have access to. |
| `pollTargets` | Array of `{ repo, checklistPath, learningsPath }` — one entry per watched repo. Ignored when `searchScope` is `"global"`. |
| `reviewerCommand` | Shell command that reads a prompt on stdin and prints review text/JSON on stdout, e.g. `"claude -p --output-format text"`. |
| `stateFile` | Where last-reviewed commit SHAs are tracked (defaults to `./state.json`, gitignored). |

`config.json` is gitignored on purpose — it's local, machine-specific config,
not something to commit.

## Try it (dry run)

Before trusting diffhawk to post anything, run it in dry-run mode. This does
everything — search, diff fetch, prompt build, invoke the reviewer CLI — but
stops short of posting to GitHub:

```bash
node bin/poll.mjs --dry-run
```

You should see one block per matching PR with a summary and finding count.
If a PR is already up to date in `state.json`, it's skipped and logged as such.

## Run for real

```bash
node bin/poll.mjs
```

This posts an actual GitHub PR review (inline comments + summary) for every
PR where you're the requested reviewer and the head commit hasn't been
reviewed yet. On success, it records the reviewed SHA in `state.json` so the
same commit isn't re-reviewed next run.

If anything fails partway (reviewer CLI errors, GitHub API rejects the post,
etc.), diffhawk logs the failure to `poll.log` and skips posting for that PR
— it never posts a broken or empty review, and leaves state untouched so the
next run retries automatically.

## Scheduling

If you skipped scheduling during `init`, or want to change it later, rerun
the wizard (it's safe to run again — it just asks the same questions) or set
it up manually:

- **cron** (macOS/Linux): add a line like
  ```
  */15 * * * * /usr/bin/node /absolute/path/to/diffhawk/bin/poll.mjs >> /absolute/path/to/diffhawk/poll.log 2>&1
  ```
- **launchd** (macOS): the wizard writes a plist to
  `~/Library/LaunchAgents/ai.socialpost.diffhawk.poll.plist` and loads it with
  `launchctl load`.
- **Windows Task Scheduler**: the wizard runs
  `schtasks /create /sc minute /mo <N> /tn diffhawk-poll /tr "node ...\bin\poll.mjs"`.

## Customizing reviews

- **`docs/checklist.md`** — what diffhawk looks for. Edit it directly; no
  code change or wizard rerun needed.
- **`docs/learnings.md`** — durable notes to stop diffhawk repeating a bad
  suggestion (e.g. "don't flag X, it's intentional because Y"). Doesn't exist
  by default — create it whenever you have a correction to record. It's
  loaded into every prompt automatically if present.

## Troubleshooting

- **`gh` not authenticated** — `gh auth login`, then rerun.
- **Reviewer CLI "found but not authenticated"** during `init` — run the
  login command it prints (e.g. `claude /login`), then continue.
- **Nothing happens on a poll run** — check `poll.log` in the repo root for
  the specific failure (search failed, reviewer adapter failed, post
  rejected, etc.).
- **A review didn't fully post** — diffhawk validates finding line numbers
  against the actual diff before posting; anything it can't anchor to a real
  line gets folded into the review's summary text instead of being dropped
  silently, so check the summary for an "Additional findings" section.

## License

[MIT](./LICENSE)
