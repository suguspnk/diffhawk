# Governance

## Maintainers

OpenMergeLens currently has a single maintainer, who has final say on scope,
design, and what gets merged. There is no formal contributor tier with merge
rights at this time.

External contributions (issues, PRs) are welcome, but merge rights are not
extended to contributors currently — this may change as the project grows,
but there's no fixed criteria or timeline for that yet.

## Change process

All changes land through a pull request, including changes made by a
maintainer. This keeps history and diffs reviewable even when no second
person is available to review.

- With a single maintainer, PRs are self-reviewed and may use the maintainer
  bypass for the approval requirement after required CI checks pass: check
  that the change matches the design constraints in [CLAUDE.md](CLAUDE.md) /
  [PRD.md](PRD.md), that any relevant tests/dry-run checks pass, and
  that docs (README, PRD, checklist) are updated if behavior changed.
- If a second maintainer joins, PRs opened by one maintainer should be
  reviewed and approved by another before merging, rather than self-merged.
- Direct pushes to `main` are avoided in favor of PRs, even for small changes,
  so there's always a reviewable diff.

## Decision-making

Design and architectural decisions (e.g. config shape, state shape, adapter
interfaces) are made by the maintainer(s), guided by the constraints recorded
in [CLAUDE.md](CLAUDE.md) and the rationale in [PRD.md](PRD.md).
Disagreements are resolved by maintainer discretion. There is no voting body
or formal RFC process at this project's current size.

## Security disclosure

Do not open a public GitHub issue for a suspected security vulnerability
(e.g. anything involving credential handling, the `gh` CLI integration, or
the reviewer-command adapter shelling out to another process).

Instead, use GitHub's private vulnerability reporting flow on this
repository (the "Report a vulnerability" option under the repo's Security
tab). This lets the maintainer(s) triage and fix the issue before any public
disclosure.

Response expectations and the supported-version policy are documented in
[SECURITY.md](SECURITY.md).

## License

OpenMergeLens is released under the [MIT License](LICENSE). Contributions are
accepted under the same license.
