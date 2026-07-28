# Security Policy

## Supported versions

OpenMergeLens is pre-1.0 software. Security fixes are provided for the latest
published version only. Upgrade before reporting a problem that is already
fixed in a newer release.

## Reporting a vulnerability

Do not open a public issue or discussion. Use GitHub's
[private vulnerability reporting](https://github.com/suguspnk/openmergelens/security/advisories/new)
flow and include:

- the affected version and operating system;
- a minimal reproduction or proof of concept;
- the expected security impact;
- whether the issue is already public; and
- any suggested mitigation.

Remove real credentials and private pull-request content. A maintainer will
acknowledge a report within seven days and provide a status update at least
every fourteen days until it is resolved or closed. Disclosure timing will be
coordinated with the reporter after a fix is available.

## Security model

OpenMergeLens processes attacker-influenced pull-request content and launches
local reviewer software. Its main controls are:

- GitHub credentials remain in the GitHub CLI credential store and are not
  persisted in OpenMergeLens configuration.
- The reviewer receives no GitHub token. A per-review local gateway permits
  read-only inspection of only the selected repository and pull request.
- Commands use argument arrays with no shell interpolation.
- Logs redact common credential formats, and local state is created with
  private filesystem permissions where the platform supports them.
- Reviews are anchored to the fetched diff and the head commit is rechecked
  before anything is posted.

Custom reviewer programs remain trusted local software. Users are responsible
for their installation, authentication, billing, privacy terms, and updates.
