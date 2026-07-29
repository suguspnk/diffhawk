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
- Application bundle identifier:
  `io.github.suguspnk.openmergelens.notifier`
- Official mark source (`docs/openmergelens-mark.svg`) SHA-256:
  `f8ee81382daf5b506396c7a0e557a24f3fdb278f7ad7ace272bf8eec73b06221`
- Generated `OpenMergeLens.icns` SHA-256:
  `2cf31849a3d209cbcd929bdf9e0680b8cfe8eb2f005d395c1b3c6548b91ba36b`
- Bundled executable SHA-256 after stripping, UUID normalization, and ad-hoc
  bundle signing:
  `2f8fe06c96236359357838e1d57ff9ccbb6b8b0ad6817cb8c17953f5dff99602`
- License: `alerter-LICENSE.md`

The official upstream ZIP is arm64-only, so OpenMergeLens reproducibly builds
the universal executable from the exact source commit. `alerter-Package.resolved`
pins the transitive source dependency. `alerter-persistent.patch` gives the
helper OpenMergeLens's dedicated bundle identity and routes timeout-zero alerts
through Apple's supported UserNotifications framework. The helper exits after
macOS accepts the request without removing the delivered notification; this
lets Notification Center retain it while the poll process exits. Swift
deterministic hashing stabilizes compiler ordering, and the normalization step
zeros per-link Mach-O UUID fields before ad-hoc signing. The notifier icon is
generated directly from the website's SVG mark with macOS system tools.

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
notifier_bundle="$openmergelens_root/vendor/OpenMergeLensNotifier.app"
mkdir -p "$notifier_bundle/Contents/MacOS" \
  "$notifier_bundle/Contents/Resources"
cp "$alerter_source_dir/Sources/Alerter/Info.plist" \
  "$notifier_bundle/Contents/Info.plist"
icon_work_dir=$(mktemp -d /tmp/openmergelens-icon.XXXXXX)
qlmanage -t -s 1024 -o "$icon_work_dir" \
  "$openmergelens_root/docs/openmergelens-mark.svg"
icon_png="$icon_work_dir/openmergelens-mark.svg.png"
for icon_size in 16 32 48 128 256 512 1024; do
  sips -s format tiff -z "$icon_size" "$icon_size" "$icon_png" \
    --out "$icon_work_dir/icon-$icon_size.tiff"
done
tiffutil -cat \
  "$icon_work_dir/icon-16.tiff" \
  "$icon_work_dir/icon-32.tiff" \
  "$icon_work_dir/icon-48.tiff" \
  "$icon_work_dir/icon-128.tiff" \
  "$icon_work_dir/icon-256.tiff" \
  "$icon_work_dir/icon-512.tiff" \
  "$icon_work_dir/icon-1024.tiff" \
  -out "$icon_work_dir/OpenMergeLens.tiff"
tiff2icns "$icon_work_dir/OpenMergeLens.tiff" \
  "$notifier_bundle/Contents/Resources/OpenMergeLens.icns"
cp "$alerter_source_dir/.build/apple/Products/Release/alerter" \
  "$notifier_bundle/Contents/MacOS/alerter"
strip -x "$notifier_bundle/Contents/MacOS/alerter"
codesign --remove-signature \
  "$notifier_bundle/Contents/MacOS/alerter" 2>/dev/null || true
node vendor/normalize-macho-uuids.mjs \
  "$notifier_bundle/Contents/MacOS/alerter"
codesign --force --sign - "$notifier_bundle/Contents/MacOS/alerter"
codesign --force --deep --sign - "$notifier_bundle"
shasum -a 256 "$notifier_bundle/Contents/MacOS/alerter"
```

OpenMergeLens uses Alerter on macOS 13 and later. It runs from the signed
`OpenMergeLensNotifier.app` bundle and selects that bundle's dedicated
identifier, so Notification Center attributes PR-derived content to
OpenMergeLens instead of impersonating another installed application.

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
