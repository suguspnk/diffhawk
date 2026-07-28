# Release Process

Only maintainers publish OpenMergeLens. Releases use Semantic Versioning and
the version in `package.json` must exactly match the Git tag with a `v` prefix.

## One-time npm bootstrap

The package must exist before npm can attach a trusted publisher. For the first
prerelease only:

1. Create or sign in to the npm maintainer account and enable account 2FA.
2. Confirm `npm view openmergelens` still returns `E404`.
3. Set a prerelease version such as `0.1.0-beta.0`.
4. Run `pnpm release:check` and inspect `npm pack --dry-run`.
5. Publish interactively with `npm publish --tag next` and complete 2FA.
6. On npmjs.com, configure this trusted publisher:
   - provider: GitHub Actions
   - owner: `suguspnk`
   - repository: `openmergelens`
   - workflow: `publish.yml`
   - environment: `npm`
   - allowed action: `npm stage publish`
7. Set package publishing access to require 2FA and disallow traditional
   automation tokens. Revoke unused publish tokens.

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
6. The `publish.yml` workflow verifies the tag, reruns release checks, and
   stages the package using npm trusted publishing. Prerelease versions use
   the `next` dist-tag; stable versions use `latest`.
7. Inspect and approve the staged package with 2FA on npmjs.com or through the
   interactive npm CLI.
8. Verify:

   ```bash
   npm view openmergelens version dist-tags
   npx openmergelens@<version> --version
   ```

If any check fails, do not move a tag or reuse a published version. Fix the
problem and release a new version. npm publication is immutable.
