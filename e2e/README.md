# Live review E2E

The normal `pnpm test` suite is fully offline. This suite is intentionally
separate because it uses the real GitHub CLI, GitHub API, configured reviewer
CLI, and per-review MCP gateway.

## What it tests

The harness runs one real OpenMergeLens poll against a dedicated GitHub pull
request and verifies the full review path:

- the configured GitHub account is available through `gh`;
- the pull request is open and requests review from that account;
- PR metadata and the diff are fetched;
- the configured reviewer CLI is invoked with the per-review MCP gateway;
- the review reaches the expected terminal step and produces valid findings;
- dry-run mode does not create a GitHub review or local state; and
- post mode creates the marker review and records the reviewed head SHA.

Use a dedicated disposable or private test PR. The PR must be open, must have
the configured GitHub account in its Reviewers list, and must have a fresh head
commit with no existing OpenMergeLens marker review.

## Prerequisites

Install dependencies and authenticate GitHub plus both reviewer CLIs before
running the matrix. The GitHub account name is supplied through
`OPENMERGELENS_E2E_USERNAME`; the token is resolved from the matching local
`gh` credential with `gh auth token --hostname ... --user ...`. Do not put a
GitHub token in the environment file.

Confirm the selected account without printing its token:

```bash
gh auth status --hostname github.com
gh auth token --hostname github.com --user e2e-reviewer >/dev/null
```

The normal test selects a backend with
`OPENMERGELENS_E2E_REVIEWER_BACKEND=claude` or `codex` and uses the same
canonical generated command as `openmergelens init`. A custom reviewer is
supported only through `OPENMERGELENS_E2E_REVIEWER_COMMAND` with both
`{{mcp_config}}` and `{{mcp_tool}}` placeholders; do not replace it with an
arbitrary shell pipeline.

## Configure the test environment

Copy the tracked example to the ignored local file and edit the repository,
PR number, account, and reviewer command:

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

The important values are:

| Variable | Meaning |
| --- | --- |
| `OPENMERGELENS_E2E_REPO` | Target repository in `OWNER/REPO` form. |
| `OPENMERGELENS_E2E_PR` | Target pull request number. |
| `OPENMERGELENS_E2E_USERNAME` | GitHub username whose stored `gh` credential is used and who must be requested for review. |
| `OPENMERGELENS_E2E_REVIEWER_BACKEND` | `claude` or `codex`; selects the canonical generated reviewer command. |
| `OPENMERGELENS_E2E_REVIEWER_COMMAND` | Optional custom MCP-compatible command; do not set it with `REVIEWER_BACKEND`. |
| `OPENMERGELENS_E2E_HOST` | GitHub host; defaults to `github.com`. |
| `OPENMERGELENS_E2E_MODE` | `dry-run` by default; use `post` only for a disposable test PR. |

For multiple stored GitHub accounts, `OPENMERGELENS_E2E_USERNAME` together with
`OPENMERGELENS_E2E_HOST` selects the exact account. The test does not rely on
whichever account happens to be active in `gh`.

## Run one backend

Set `OPENMERGELENS_E2E_REVIEWER_BACKEND` to the backend under test, then run
the dry-run. The default is safe and does not post:

```bash
pnpm test:e2e:review
```

This makes real GitHub and reviewer calls, but uses a temporary isolated
`OPENMERGELENS_HOME`. It removes that state afterward and does not post a
review. Set `OPENMERGELENS_E2E_KEEP_HOME=1` when diagnosing a failure; the test
prints the retained directory containing `poll.log`, `config.json`, and review
files.

Use `OPENMERGELENS_E2E_REVIEW_FOCUS_COUNT=1` for a fast smoke pass. Set it to
`4` when you want all review focus passes plus synthesis.

## Run both Claude and Codex

With the common repository, PR, account, and dry-run settings loaded from
`e2e/test.env`, run:

```bash
pnpm test:e2e:review:matrix
```

The matrix runs the live test twice, once with the canonical Claude command and
once with the canonical Codex command. It runs both even if the first backend
fails, and returns a failing exit code if either backend fails. The matrix is
dry-run-only so both backends can safely inspect the same test PR without
creating duplicate reviews. Do not set `OPENMERGELENS_E2E_REVIEWER_COMMAND`
when using the matrix.

## Run the posting-path test

Posting is a single-backend operation. First push a fresh commit to the test PR
and request the configured reviewer account again. Confirm that the current
head has no OpenMergeLens marker review. Set the backend in `e2e/test.env`, then
run:

```bash
OPENMERGELENS_E2E_MODE='post' \
OPENMERGELENS_E2E_POST_CONFIRM='I_UNDERSTAND_POSTING_TO_TEST_PR' \
pnpm test:e2e:review
```

Post mode verifies the marker review exists on GitHub and that isolated local
state records the reviewed head SHA. To post-test both backends, use a fresh
head commit or separate disposable PR for each backend. Never point this mode
at a production PR.

## Setup E2E coverage

The interactive setup tests are separate from the live GitHub review test.
They cover the real `init` process through a PTY, scheduler artifact
installation/removal, and the native notification setup contract without
using a real GitHub account or modifying the host scheduler.

Run the interactive init matrix:

```bash
pnpm test:e2e:init
```

It runs once with a Claude fixture and once with a Codex fixture. The harness
uses a temporary `OPENMERGELENS_HOME`, fake `gh` and reviewer executables, and
a temporary scheduler home. It confirms the existing account/repository
selection, backend detection, consent, review settings, scheduler cleanup,
prompt/learnings file creation, setup completion, and operation-lock cleanup.
It does not call GitHub, invoke a real reviewer, or touch the user's real
launchd/cron entries. Run one backend while diagnosing with
`OPENMERGELENS_E2E_INIT_BACKEND=claude` or `codex`.

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

- **Missing environment:** copy `e2e/test.env.example`, set `OPENMERGELENS_E2E_REVIEWER_BACKEND` to `claude` or `codex`, and source `e2e/test.env` in the same shell that runs pnpm.
- **Credential mismatch:** verify that `OPENMERGELENS_E2E_USERNAME` exactly matches `gh auth status` and that `gh auth token --hostname "$OPENMERGELENS_E2E_HOST" --user "$OPENMERGELENS_E2E_USERNAME"` succeeds.
- **PR not discovered:** add the account to the PR's Reviewers list and request it again after pushing the fresh head commit.
- **Existing marker:** use a new test commit or a new disposable PR; the harness refuses to post twice for the same account and head.
- **Reviewer failure:** confirm that the selected CLI is installed and authenticated. For a single backend, retain the temporary home to inspect `poll.log`; for the matrix, run the failing backend alone with `pnpm test:e2e:review`.
- **Ambiguous reviewer settings:** unset `OPENMERGELENS_E2E_REVIEWER_COMMAND` when selecting `REVIEWER_BACKEND`; custom commands and generated backends are mutually exclusive.
- **Init E2E cannot start:** install the POSIX `expect` utility; the setup matrix requires a real PTY and skips only on Windows.
- **Notification UI E2E:** run it from a graphical terminal with `OPENMERGELENS_E2E_NOTIFICATION_UI=1`; a headless shell or a missing notification permission is expected to fail the test.
