# Changelog

OpenMergeLens follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
