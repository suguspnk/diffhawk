# Vendored macOS notification helpers

## Alerter

`alerter` is built from the maintained open-source
[`alerter`](https://github.com/vjeantet/alerter) project:

- Version: 26.5
- Upstream tag: `v26.5`
- Architectures: `x86_64` and `arm64`
- Minimum macOS deployment target: 13.0
- Executable SHA-256 after stripping and ad-hoc signing:
  `21af5581efea69223b4b19f360f3d904a69c360841ef2c0543e10dd338b792c7`
- License: `alerter-LICENSE.md`

The universal executable was built with Xcode 26.3 and Swift 6.1:

```sh
swift build -c release --arch arm64 --arch x86_64
cp .build/apple/Products/Release/alerter /tmp/alerter-universal
strip -x /tmp/alerter-universal
codesign --force --sign - /tmp/alerter-universal
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
