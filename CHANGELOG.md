# Changelog

OpenMergeLens follows [Semantic Versioning](https://semver.org/). While the
project is below 1.0, minor releases may contain documented configuration or
behavior changes.

## [Unreleased]

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

## [0.1.0-beta.0] - Unreleased

Initial public beta of local, scheduled, agent-agnostic GitHub pull-request
reviews.
