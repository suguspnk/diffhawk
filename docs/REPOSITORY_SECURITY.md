# Repository security baseline

This document is the reviewable source of truth for GitHub repository
settings. GitHub settings remain server-side controls, so maintainers must
verify them after changing collaborators, workflows, environments, or release
permissions.

## Access model

- `@suguspnk` is the sole maintainer and code owner.
- Other collaborators may receive the least repository role needed for their
  work, but write access alone must not satisfy required reviews.
- Adding another maintainer requires a governance pull request that updates
  both `GOVERNANCE.md` and `.github/CODEOWNERS` before repository access is
  expanded.
- Review repository collaborators quarterly and remove dormant write access.

## Protected `main` branch

Configure the branch protection rule for `main` with all of these controls:

- Require a pull request before merging.
- Require at least one approving review.
- Require review from Code Owners.
- Dismiss stale approvals when new commits are pushed.
- Require approval of the most recent reviewable push.
- Require the `CI gate` status check and require the branch to be current.
- Require conversation resolution.
- Block force pushes and branch deletion.
- Do not allow GitHub Actions to approve pull requests.

The single-maintainer project currently retains administrator bypass only for
account-recovery and broken-protection emergencies. Every use must be recorded
in the pull request with the reason and the verification performed. Once a
second maintainer is added, enable enforcement for administrators and require
normal peer approval instead of bypass.

## Sensitive changes

Treat changes to these paths as security-sensitive even when tests pass:

- `.github/**`, `.github/CODEOWNERS`, and release documentation;
- `package.json`, `pnpm-lock.yaml`, and `npm-shrinkwrap.json`;
- `bin/**`, `lib/**`, and `vendor/**`; and
- `docs/**`, because `main:/docs` deploys directly to GitHub Pages.

Review the complete diff, confirm the expected head SHA immediately before
merging, and verify the relevant deployment after merge.

## Periodic verification

At least quarterly, verify the protected branch, collaborators, Actions
permissions, environments, deploy keys, webhooks, and security-alert status.
Also confirm that release-tag rules still restrict `v*` creation, update, and
deletion to the maintainer and that the npm environment contains no long-lived
publish token.
