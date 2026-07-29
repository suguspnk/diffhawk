# Changelog

OpenMergeLens follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.1] - 2026-07-29

- Replaced repository-by-repository AI-processing confirmations with one
  explicit consent covering the complete selected repository set. Existing
  version 2 configs migrate conservatively, and reviewer or repository-set
  changes require one fresh bulk confirmation.
- Skip pull requests that are already closed or merged, and re-check their
  state before posting so a pull request closed during review is not updated.
- Added a concise README quick start and a maintainer launch field guide for
  clean-install checks, early-user interviews, privacy-preserving measurements,
  and feedback routing.
- Replaced deprecated macOS notification delivery on macOS 13 and later with a
  maintained universal helper in a dedicated OpenMergeLens application bundle,
  using the website's official mark while preserving the legacy helper for
  older Macs. The notifier bundle version now invalidates pre-logo macOS icon
  registrations.
- Added a setup-time desktop notification test with confirmation and
  platform-specific recovery guidance when delivery fails or the operating
  system suppresses the alert. The confirmation is displayed while the test
  alert is active, every setup-only probe uses a fresh notification identity,
  and macOS guidance explains that the locally signed helper cannot override
  Focus.
- macOS 13+ notifications now remain until the user dismisses them. A newer
  OpenMergeLens notification replaces the previous one without blocking polls.

## [1.0.1] - 2026-07-29

- Fixed non-interactive Codex reviews cancelling the constrained GitHub
  inspection tool, and rejected reviewer output unless required PR metadata and
  cumulative diff reads complete successfully.
- Pointed published package metadata at the canonical OpenMergeLens product
  site.

## [1.0.0] - 2026-07-28

Initial stable release of local, scheduled GitHub pull-request reviews using
Codex, Claude Code, or a compatible MCP-enabled reviewer CLI.

- Added cross-platform CI and installed-package smoke testing.
- Added staged npm publishing with trusted-publisher provenance.
- Added community health, security, support, and release documentation.
- Added standard `--help` and `--version` CLI flags.
- Raised the supported runtime to maintained Node.js releases.
- Made reviewer-command safety validation fail at configuration load time.
- Corrected the bundled manual configuration example.
- Added visible AI attribution to every posted pull-request review.
- Added repository-scoped consent before third-party AI processing, with
  re-consent when the reviewer backend changes.
- Serialized GitHub review mutations and added rate-limit-aware backoff.
