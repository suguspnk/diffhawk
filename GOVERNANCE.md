# Governance

## Maintainers

OpenMergeLens currently has a single human maintainer, who has final say on
scope, design, and what gets merged. There is no formal contributor tier with
merge rights at this time.

The maintainer controls two authorized GitHub identities, `@suguspnk` and
`@sera240910`; both are code owners. Repository roles used for triage,
automation, or collaboration do not confer maintainer status and must not
satisfy the protected branch's code-owner approval requirement.

External contributions (issues, PRs) are welcome, but merge rights are not
extended to contributors currently. This may change as the project grows,
but there's no fixed criteria or timeline for that yet.

## Change process

All changes land through a pull request, including changes made by a
maintainer. This keeps history and diffs reviewable even when no second
person is available to review.

- While both authorized accounts remain under the same maintainer's control,
  maintainer-authored PRs use the other authorized account for the required
  approval after CI passes. The approving account must review the complete
  diff, must not be the latest pusher, and must confirm that the change matches
  [CLAUDE.md](CLAUDE.md) / [PRD.md](PRD.md), relevant verification passes, and
  affected user, design, and release documentation is current.
- If a second maintainer joins, PRs opened by one maintainer should be
  reviewed and approved by another before merging, rather than self-merged.
- Direct pushes to `main` are avoided in favor of PRs, even for small changes,
  so there's always a reviewable diff.

The repository protection settings are part of this governance contract. They
must match [docs/REPOSITORY_SECURITY.md](docs/REPOSITORY_SECURITY.md). In
particular, `main` requires a current code-owner approval and a current CI
gate; an approval from an account with generic write access is insufficient.
Administrative bypass is reserved for documented break-glass recovery and is
not the normal merge path.

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
