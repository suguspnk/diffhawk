# Vendored macOS notification helpers

## Alerter

`alerter` is built from the maintained open-source
[`alerter`](https://github.com/vjeantet/alerter) project:

- Version: 26.5
- Upstream tag: `v26.5`
- Upstream commit: `6070136eb72a0f63a10abfe350c51e0007fd8341`
- Upstream source tree: `faf9c4f826c6a948a38cee9a55935e7514a07b02`
- Upstream release ZIP SHA-256, independently published by GitHub:
  `11f63cddc9bb3f8554ed9b762632a120cfa7bee05e3c09d65734823e09d24f10`
- `swift-argument-parser` commit:
  `c5d11a805e765f52ba34ec7284bd4fcd6ba68615`
- Architectures: `x86_64` and `arm64`
- Minimum macOS deployment target: 13.0
- Executable SHA-256 after stripping, UUID normalization, and ad-hoc signing:
  `744c5f4505eb44793a3b0a1205efb7c7d2b5943836491a4058aca88a51e9e458`
- License: `alerter-LICENSE.md`

The official upstream ZIP is arm64-only, so OpenMergeLens reproducibly builds
the universal executable from the exact source commit. `alerter-Package.resolved`
pins the transitive source dependency. `alerter-persistent.patch` makes a
timeout-zero notification exit after macOS confirms delivery without removing
the delivered notification; this lets Notification Center retain it while the
poll process exits. Swift deterministic hashing stabilizes compiler ordering,
and the normalization step zeros per-link Mach-O UUID fields before ad-hoc
signing.

The executable was built with Xcode 26.3 and Swift 6.1:

```sh
openmergelens_root=$(pwd)
alerter_source_dir=/tmp/openmergelens-alerter-26.5
git clone https://github.com/vjeantet/alerter.git "$alerter_source_dir"
git -C "$alerter_source_dir" checkout --detach \
  6070136eb72a0f63a10abfe350c51e0007fd8341
cp "$openmergelens_root/vendor/alerter-Package.resolved" \
  "$alerter_source_dir/Package.resolved"
git -C "$alerter_source_dir" apply \
  "$openmergelens_root/vendor/alerter-persistent.patch"
env SWIFT_DETERMINISTIC_HASHING=1 swift build \
  --package-path "$alerter_source_dir" \
  -c release --arch arm64 --arch x86_64
cp "$alerter_source_dir/.build/apple/Products/Release/alerter" \
  /tmp/alerter-universal
strip -x /tmp/alerter-universal
codesign --remove-signature /tmp/alerter-universal 2>/dev/null || true
node vendor/normalize-macho-uuids.mjs /tmp/alerter-universal
codesign --force --sign - /tmp/alerter-universal
shasum -a 256 /tmp/alerter-universal
```

OpenMergeLens uses Alerter on macOS 13 and later. Version 26.4 fixed current
macOS releases silently dropping notifications from unrecognized sender
identities; OpenMergeLens explicitly selects Alerter's compatible
`com.apple.Terminal` sender identity.

## terminal-notifier

`terminal-notifier.app` is built from the established open-source
[`terminal-notifier`](https://github.com/julienXX/terminal-notifier) project:

- Version: 1.7.2
- Upstream commit: `8efbb0e977f57d7430e8f1e42e874a426080a8f3`
- Architectures: `x86_64` and `arm64`
- Minimum macOS deployment target: 11.0
- Executable SHA-256 after ad-hoc signing:
  `2c50bb38ae9e8d73b52dc19762374f26f693377eb3e52c24add49de119a8e10c`

The universal app was built with:

```sh
xcodebuild \
  -project "Terminal Notifier.xcodeproj" \
  -scheme "Terminal Notifier" \
  -configuration Release \
  ARCHS="x86_64 arm64" \
  ONLY_ACTIVE_ARCH=NO \
  MACOSX_DEPLOYMENT_TARGET=11.0 \
  CODE_SIGNING_ALLOWED=NO \
  -derivedDataPath /tmp/terminal-notifier-build \
  build
codesign --force --deep --sign - terminal-notifier.app
```

The upstream Terminal icon was removed because it is not covered by the MIT
license. macOS displays the generic application icon instead.

OpenMergeLens retains this helper only for macOS 12 and earlier because Alerter
26.5 requires macOS 13.
