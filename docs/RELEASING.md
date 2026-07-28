# Release Process

Only maintainers publish OpenMergeLens. Releases use Semantic Versioning and
the version in `package.json` must exactly match the Git tag with a `v` prefix.

## One-time npm bootstrap

The package must exist before npm can attach a trusted publisher. For the first
stable release only:

1. Create or sign in to the npm maintainer account, verify its email address,
   and enable account 2FA for authorization and writes.
2. Confirm `npm view openmergelens` still returns `E404`.
3. Set the package and changelog version to `1.0.0`.
4. Run `pnpm release:check` and inspect `npm pack --dry-run`.
5. Merge the release pull request after CI passes.
6. From the exact merged release commit, publish interactively with
   `npm publish --tag latest` and complete 2FA.
7. On npmjs.com, configure this trusted publisher:
   - provider: GitHub Actions
   - owner: `suguspnk`
   - repository: `openmergelens`
   - workflow: `publish.yml`
   - environment: `npm`
   - allowed action: `npm stage publish`
8. Set package publishing access to require 2FA and disallow traditional
   automation tokens. Revoke unused publish tokens.
9. Create the Git tag and GitHub release `v1.0.0`. Do not dispatch
   `publish.yml` for this bootstrap version because it was published
   interactively and npm versions are immutable.

## Normal release

1. Update `CHANGELOG.md` and choose the version.
2. Update `package.json`; run `pnpm install --lockfile-only` if the lockfile
   records package metadata changes.
3. Run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm release:check
   git diff --check
   ```

4. Merge the release pull request after CI passes.
5. Create a GitHub release for the exact tag `v<version>`. Mark prereleases as
   prereleases and generate release notes.
6. Manually dispatch `publish.yml` with that exact tag:

   ```bash
   gh workflow run publish.yml -f release_tag=v<version>
   ```

   The workflow verifies that the input names an existing tag pointing at the
   checked-out commit, verifies that the tag matches `package.json`, reruns
   release checks, and stages the package using npm trusted publishing.
   Prerelease versions use the `next` dist-tag; stable versions use `latest`.
7. Inspect and approve the staged package with 2FA on npmjs.com or through the
   interactive npm CLI.
8. Verify:

   ```bash
   npm view openmergelens version dist-tags
   npx openmergelens@<version> --version
   ```

If any check fails, do not move a tag or reuse a published version. Fix the
problem and release a new version. npm publication is immutable.
