# Live review E2E

The normal `pnpm test` suite is fully offline. This suite is intentionally
separate because it uses the real GitHub CLI, GitHub API, configured reviewer
CLI, and per-review MCP gateway.

Use a dedicated disposable or private test PR. The PR must be open, must have
the configured GitHub account in its Reviewers list, and must have a fresh head
commit with no existing OpenMergeLens marker review.

Required environment:

```bash
export OPENMERGELENS_E2E_REPO='OWNER/REPO'
export OPENMERGELENS_E2E_PR='123'
export OPENMERGELENS_E2E_USERNAME='reviewer-account'
export OPENMERGELENS_E2E_REVIEWER_COMMAND='codex exec ...'
```

Optional controls:

```bash
export OPENMERGELENS_E2E_HOST='github.com'          # default
export OPENMERGELENS_E2E_REVIEW_FOCUS_COUNT='1'     # default; use 4 for full coverage
export OPENMERGELENS_E2E_REVIEW_TIMEOUT_MS='720000'  # default
export OPENMERGELENS_E2E_KEEP_HOME='1'              # retain temporary state for debugging
```

Run a real review without posting:

```bash
pnpm test:e2e:review
```

This still performs real account authentication, review-request discovery,
PR metadata and diff access, reviewer invocation, MCP gateway inspection, and
finding validation. It asserts that no GitHub review or local review state is
created.

To test the real posting path, create a fresh test commit and explicitly opt in:

```bash
export OPENMERGELENS_E2E_MODE='post'
export OPENMERGELENS_E2E_POST_CONFIRM='I_UNDERSTAND_POSTING_TO_TEST_PR'
pnpm test:e2e:review
```

Post mode verifies the marker review exists on GitHub and that local state
records the reviewed head SHA. It is not safe to point this at a production PR.

The interactive `openmergelens init` wizard is deliberately not run by the
review test: it can change host scheduler entries and desktop-notification
state. Run `OPENMERGELENS_HOME=<temporary-directory> openmergelens init`
manually against the same dedicated test account, choose the manual scheduler,
disable notifications, and then run the E2E review command above. The
non-interactive setup boundary and configuration builder remain covered by the
offline test suite.
