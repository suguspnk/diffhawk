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

Install dependencies and authenticate both GitHub and the reviewer CLI before
running the test. The GitHub account name is supplied through
`OPENMERGELENS_E2E_USERNAME`; the token is resolved from the matching local
`gh` credential with `gh auth token --hostname ... --user ...`. Do not put a
GitHub token in the environment file.

Confirm the selected account without printing its token:

```bash
gh auth status --hostname github.com
gh auth token --hostname github.com --user e2e-reviewer >/dev/null
```

The reviewer command must be one of the generated Codex/Claude commands, or a
custom command containing both `{{mcp_config}}` and `{{mcp_tool}}` placeholders.
Use the exact command written by `openmergelens init` or shown in
`config.example.json`; do not replace it with an arbitrary shell pipeline.

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
| `OPENMERGELENS_E2E_REVIEWER_COMMAND` | Authenticated reviewer CLI command. |
| `OPENMERGELENS_E2E_HOST` | GitHub host; defaults to `github.com`. |
| `OPENMERGELENS_E2E_MODE` | `dry-run` by default; use `post` only for a disposable test PR. |

For multiple stored GitHub accounts, `OPENMERGELENS_E2E_USERNAME` together with
`OPENMERGELENS_E2E_HOST` selects the exact account. The test does not rely on
whichever account happens to be active in `gh`.

## Run the non-posting live test

Dry-run is the default and is the required first pass:

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

## Run the posting-path test

First push a fresh commit to the test PR and request the configured reviewer
account again. Confirm that the current head has no OpenMergeLens marker review.
Then run:

```bash
OPENMERGELENS_E2E_MODE='post' \
OPENMERGELENS_E2E_POST_CONFIRM='I_UNDERSTAND_POSTING_TO_TEST_PR' \
pnpm test:e2e:review
```

Post mode verifies the marker review exists on GitHub and that isolated local
state records the reviewed head SHA. Never point this mode at a production PR.

## Init wizard coverage

The live review harness does not run the interactive `openmergelens init`
wizard. Init can change host scheduler entries and desktop-notification state,
so the review test builds a validated config in its own temporary home instead.
The init setup boundary and configuration builder are covered by the offline
suite.

For a separate manual init smoke test, use another temporary home, select the
same test account and repository, disable notifications, and choose the manual
scheduler:

```bash
init_home=$(mktemp -d)
OPENMERGELENS_HOME="$init_home" pnpm run init
```

This verifies the wizard safely but is intentionally separate from the live
review run; the E2E harness creates a fresh isolated config for each review.

## Troubleshooting

- **Missing environment:** copy `e2e/test.env.example`, edit it, and source `e2e/test.env` in the same shell that runs pnpm.
- **Credential mismatch:** verify that `OPENMERGELENS_E2E_USERNAME` exactly matches `gh auth status` and that `gh auth token --hostname "$OPENMERGELENS_E2E_HOST" --user "$OPENMERGELENS_E2E_USERNAME"` succeeds.
- **PR not discovered:** add the account to the PR's Reviewers list and request it again after pushing the fresh head commit.
- **Existing marker:** use a new test commit or a new disposable PR; the harness refuses to post twice for the same account and head.
- **Reviewer failure:** use the exact generated reviewer command and confirm that the reviewer CLI is authenticated. Retain the temporary home to inspect `poll.log`.
