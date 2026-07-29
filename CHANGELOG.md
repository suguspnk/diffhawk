# Changelog

OpenMergeLens follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Replaced deprecated macOS notification delivery on macOS 13 and later with a
  maintained universal helper in a dedicated OpenMergeLens application bundle,
  using the website's official mark while preserving the legacy helper for
  older Macs.
- Added a setup-time desktop notification test with confirmation and
  platform-specific recovery guidance when delivery fails or the operating
  system suppresses the alert. The confirmation is displayed while the test
  alert is active, and the setup-only probe bypasses Focus.
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
