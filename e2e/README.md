# Live review E2E

The normal `pnpm test` suite is fully offline. This suite is intentionally
separate because it uses the real GitHub CLI, GitHub API, configured reviewer
CLI, and per-review MCP gateway.

## What it tests

By default, the harness creates a disposable pull request in the explicitly
configured repository, requests the reviewer account, runs one real
OpenMergeLens poll in post mode, verifies the resulting inline review comment,
then closes the PR and deletes its branch. It verifies the full review path:

- the configured GitHub account is available through `gh`;
- the disposable pull request is open and requests review from that account;
- PR metadata and the diff are fetched;
- the configured reviewer CLI is invoked with the per-review MCP gateway;
- the review reaches the expected terminal step and produces valid findings;
- dry-run mode does not create a GitHub review or local state; and
- post mode creates the marker review with an anchored inline comment and
  records the reviewed head SHA.

Use a dedicated disposable or private test repository. Provisioning requires
two different stored `gh` accounts: the author creates and cleans up the PR,
and the reviewer account is requested and used by OpenMergeLens. The author
needs permission to create branches and pull requests; the reviewer needs
permission to inspect and comment on PRs.

## Prerequisites

Install dependencies and authenticate GitHub plus the selected reviewer CLI
before running the test. The author and reviewer names are supplied through
`OPENMERGELENS_E2E_AUTHOR_USERNAME` and `OPENMERGELENS_E2E_USERNAME`; tokens are
resolved from the matching local `gh` credentials. Do not put a GitHub token in
the environment file.

Confirm the selected account without printing its token:

```bash
gh auth status --hostname github.com
gh auth token --hostname github.com --user author-account >/dev/null
gh auth token --hostname github.com --user reviewer-account >/dev/null
```

The normal test selects a backend with
`OPENMERGELENS_E2E_REVIEWER_BACKEND=claude` or `codex` and uses the same
canonical generated command as `openmergelens init`. A custom reviewer is
supported only through `OPENMERGELENS_E2E_REVIEWER_COMMAND` with both
`{{mcp_config}}` and `{{mcp_tool}}` placeholders; do not replace it with an
arbitrary shell pipeline.

## Configure the test environment

Copy the tracked example to the ignored local file in the primary project
worktree and edit the dedicated repository, two account names, and reviewer
command:

```bash
cp e2e/test.env.example e2e/test.env
$EDITOR e2e/test.env
```

Load the file into the current shell. It is a shell-format environment file,
so only source a file you created or reviewed locally:

```bash
set -a
source e2e/test.env
set +a
```

The tracked `.githooks/post-checkout` hook copies this private
`e2e/test.env` from the primary project worktree into a newly created
worktree. Enable the tracked hooks once per clone or repository checkout with:

```bash
git config core.hooksPath .githooks
```

The hook never overwrites an existing `e2e/test.env` and does nothing when the
primary project worktree does not have one.

The important values are:

| Variable | Meaning |
| --- | --- |
| `OPENMERGELENS_E2E_REPO` | Dedicated target repository in `OWNER/REPO` form. |
| `OPENMERGELENS_E2E_AUTHOR_USERNAME` | Stored `gh` account used to create and clean up the disposable PR. Required when provisioning. |
| `OPENMERGELENS_E2E_USERNAME` | Stored `gh` account requested for review and used by OpenMergeLens. |
| `OPENMERGELENS_E2E_PR` | Existing pull request number; used only when provisioning is disabled. |
| `OPENMERGELENS_E2E_REVIEWER_BACKEND` | `claude` or `codex`; selects the canonical generated reviewer command. |
| `OPENMERGELENS_E2E_REVIEWER_COMMAND` | Optional custom MCP-compatible command; do not set it with `REVIEWER_BACKEND`. |
| `OPENMERGELENS_E2E_HOST` | GitHub host; defaults to `github.com`. |
| `OPENMERGELENS_E2E_MODE` | `post` by default; use `dry-run` when no GitHub review should be created. |
| `OPENMERGELENS_E2E_PROVISION` | `1` by default; set to `0` to use `OPENMERGELENS_E2E_PR`. |
| `OPENMERGELENS_E2E_BASE_BRANCH` | Optional safe base branch; otherwise the repository default branch is used. |
| `OPENMERGELENS_E2E_KEEP_PR` | Set to `1` to retain a provisioned PR and branch for diagnosis. |

For multiple stored GitHub accounts, `OPENMERGELENS_E2E_USERNAME` together with
`OPENMERGELENS_E2E_HOST` selects the exact account. The test does not rely on
whichever account happens to be active in `gh`.

## Run one backend

Set `OPENMERGELENS_E2E_REVIEWER_BACKEND` to the backend under test, then run:

```bash
pnpm test:e2e:review
```

This creates a disposable PR, makes real GitHub and reviewer calls, posts a
real review, checks for an inline comment, and removes the PR, branch, and
temporary isolated `OPENMERGELENS_HOME` afterward. Set
`OPENMERGELENS_E2E_KEEP_PR=1` and/or `OPENMERGELENS_E2E_KEEP_HOME=1` when
diagnosing a failure; retained paths are printed by the test.

For a non-posting run against an existing PR, use a fresh head with the
reviewer requested and no marker review:

```bash
OPENMERGELENS_E2E_PROVISION=0 \
OPENMERGELENS_E2E_PR=123 \
OPENMERGELENS_E2E_MODE=dry-run \
pnpm test:e2e:review
```

Use `OPENMERGELENS_E2E_REVIEW_FOCUS_COUNT=1` for a fast smoke pass. Set it to
`4` when you want all review focus passes plus synthesis.

## Run both Claude and Codex

With the repository, reviewer, and backend settings loaded from `e2e/test.env`,
run:

```bash
pnpm test:e2e:review:matrix
```

The matrix runs the live test twice, once with the canonical Claude command and
once with the canonical Codex command. It forces dry-run mode, runs both even
if the first backend fails, and returns a failing exit code if either backend
fails. With provisioning enabled, each backend gets its own disposable PR;
with `OPENMERGELENS_E2E_PROVISION=0`, both runs can inspect the same existing
test PR without creating reviews. Do not set
`OPENMERGELENS_E2E_REVIEWER_COMMAND` when using the matrix.

## Run the posting-path test

Posting is a single-backend operation. The default command provisions a fresh
PR, requests the reviewer, posts a review, verifies an inline comment, and
cleans up:

```bash
pnpm test:e2e:review
```

Post mode verifies that the marker review belongs to the reviewer account, is
attached to the current head, contains at least one real inline review comment,
and that isolated local state records the reviewed head SHA. Never point this
mode at a production PR. Set `OPENMERGELENS_E2E_KEEP_PR=1` if you need to
inspect the resulting GitHub review manually.

## Setup E2E coverage

The interactive setup tests are separate from the live GitHub review test.
They cover the real `init` process through a PTY, scheduler artifact
installation/removal, and the native notification setup contract without
using a real GitHub account or modifying the host scheduler.

Run the interactive init matrix:

```bash
pnpm test:e2e:init
```

It runs each backend fixture through both the manual path and the installed
current-host scheduler path: launchd on macOS or cron on Linux. The harness
uses a temporary `OPENMERGELENS_HOME`, fake `gh`, reviewer, and scheduler
executables, and a temporary scheduler home. It confirms the existing
account/repository selection, backend detection, consent, review settings,
manual scheduler cleanup, installed scheduler artifacts/log, prompt/learnings
file creation, setup completion, and operation-lock cleanup. It does not call
GitHub, invoke a real reviewer, or touch the user's real launchd/cron entries.
Windows keeps the existing POSIX PTY skip; its Task Scheduler installer remains
covered by `pnpm test:e2e:scheduler`. Run one backend and scheduler mode while
diagnosing with `OPENMERGELENS_E2E_INIT_BACKEND=claude` or `codex` and
`OPENMERGELENS_E2E_INIT_SCHEDULER=manual` or `installed`.

Run the scheduler installation test:

```bash
pnpm test:e2e:scheduler
```

The test exercises the current platform's installer against temporary files
and a fake external scheduler command: launchd on macOS, cron on Linux, or
Task Scheduler's artifact/command boundary on Windows. It verifies the
generated schedule/environment/log artifacts and removes the test schedule
before finishing. It never invokes the real host scheduler.

Run the native desktop notification UI test only when a person is present at
a graphical terminal:

```bash
OPENMERGELENS_E2E_NOTIFICATION_UI=1 pnpm test:e2e:notification:ui
```

The test sends the same setup notification used by `init`, then asks the
operator to type `VISIBLE` or `NOT_VISIBLE`. This is intentionally not
CI-safe: it requires OS notification permissions, an active desktop session,
and human confirmation. Without the explicit opt-in variable it refuses to
send a notification.

The fully manual wizard remains available when testing a real desktop setup:

```bash
init_home=$(mktemp -d)
OPENMERGELENS_HOME="$init_home" pnpm run init
```

Use the manual scheduler choice unless you have explicitly reviewed the
selected host scheduler. The automated setup tests above are the safe,
repeatable coverage for CI or local regression runs.

## Troubleshooting

- **Missing environment:** copy `e2e/test.env.example` to `e2e/test.env`, set the dedicated repository, author/reviewer accounts, and `OPENMERGELENS_E2E_REVIEWER_BACKEND`, then source `e2e/test.env` in the same shell that runs pnpm.
- **Credential mismatch:** verify both usernames against `gh auth status` and that `gh auth token --hostname "$OPENMERGELENS_E2E_HOST" --user "$OPENMERGELENS_E2E_AUTHOR_USERNAME"` and the equivalent reviewer command succeed.
- **PR not discovered:** for an existing PR, add the reviewer account to the PR's Reviewers list and request it again after pushing the fresh head commit. Provisioned PRs request it automatically.
- **Existing marker:** use provisioning or a new test commit; the harness refuses to post twice for the same account and head.
- **Reviewer failure:** confirm that the selected CLI is installed and authenticated. For a single backend, retain the temporary home to inspect `poll.log`; for the matrix, run the failing backend alone with `pnpm test:e2e:review`.
- **Ambiguous reviewer settings:** unset `OPENMERGELENS_E2E_REVIEWER_COMMAND` when selecting `REVIEWER_BACKEND`; custom commands and generated backends are mutually exclusive.
- **Init E2E cannot start:** install the POSIX `expect` utility; the setup matrix requires a real PTY and skips only on Windows.
- **Notification UI E2E:** run it from a graphical terminal with `OPENMERGELENS_E2E_NOTIFICATION_UI=1`; a headless shell or a missing notification permission is expected to fail the test.
