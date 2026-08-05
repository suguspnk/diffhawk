# Contributing to OpenMergeLens

Thanks for helping improve OpenMergeLens. Bug reports, focused feature
proposals, documentation fixes, and pull requests are welcome.

## Before starting

- Use Discussions for setup questions and ideas that are not yet concrete.
- Search existing issues and pull requests before opening a duplicate.
- Report vulnerabilities through the private process in
  [SECURITY.md](SECURITY.md), never through a public issue.
- For a substantial behavior or architecture change, open an issue first so
  scope and compatibility can be agreed before implementation.

## Development setup

Requirements:

- Node.js 22.14+ in the Node 22 line, or Node.js 24.x;
- pnpm 11.17.0;
- GitHub CLI for live dry-run testing; and
- a supported reviewer CLI for end-to-end testing.

```bash
git clone https://github.com/suguspnk/openmergelens.git
cd openmergelens
pnpm install --frozen-lockfile
pnpm test
```

Read [PRD.md](PRD.md),
[docs/CODE_QUALITY_GUIDELINES.md](docs/CODE_QUALITY_GUIDELINES.md), and
[docs/tech-stack-standards.md](docs/tech-stack-standards.md) before changing
runtime behavior. They define the product's trust boundaries and architecture.

## Pull requests

Keep changes focused and include:

- tests for changed behavior and important failure paths;
- documentation for user-visible behavior;
- compatibility notes for macOS, Windows, and Linux;
- security analysis when touching credentials, subprocesses, PR content,
  filesystem permissions, or GitHub review posting; and
- a clear explanation when a relevant check cannot be run.

Run these before requesting review:

```bash
pnpm test
pnpm release:check
git diff --check
```

Never include tokens, private pull-request data, local config, state, or logs in
a commit or public issue. Contributions are accepted under the MIT License.
