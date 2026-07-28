# Vendored terminal-notifier

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
