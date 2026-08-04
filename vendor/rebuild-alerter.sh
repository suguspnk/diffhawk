#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
expected_root=${OPENMERGELENS_EXPECTED_ROOT:-$project_root}
upstream_commit=6070136eb72a0f63a10abfe350c51e0007fd8341
expected_xcode_version='Xcode 26.3'
default_developer_dir=/Applications/Xcode_26.3.app/Contents/Developer
work_root=$(mktemp -d "${TMPDIR:-/tmp}/openmergelens-alerter.XXXXXX")
source_dir="$work_root/source"
bundle_dir="$work_root/OpenMergeLensNotifier.app"
expected_bundle="$expected_root/vendor/OpenMergeLensNotifier.app"

cleanup() {
  rm -rf "$work_root"
}
trap cleanup EXIT HUP INT TERM

if [ -d "$default_developer_dir" ]; then
  DEVELOPER_DIR=${DEVELOPER_DIR:-$default_developer_dir}
  export DEVELOPER_DIR
fi

if [ "$(xcodebuild -version | sed -n '1p')" != "$expected_xcode_version" ]; then
  echo "reproducible notifier build requires $expected_xcode_version" >&2
  exit 1
fi

if [ "$(plutil -extract CFBundleExecutable raw "$expected_bundle/Contents/Info.plist")" != 'alerter' ] ||
   [ -n "$(find "$expected_bundle" -type l -print -quit)" ]; then
  echo 'vendored alerter bundle has an unsafe executable layout' >&2
  exit 1
fi

bundle_files=$(cd "$expected_bundle" && find . -type f -print | LC_ALL=C sort)
expected_bundle_files='./Contents/Info.plist
./Contents/MacOS/alerter
./Contents/Resources/OpenMergeLens.icns
./Contents/_CodeSignature/CodeResources'
if [ "$bundle_files" != "$expected_bundle_files" ]; then
  echo 'vendored alerter bundle contains an unexpected file' >&2
  exit 1
fi

git clone --quiet https://github.com/vjeantet/alerter.git "$source_dir"
git -C "$source_dir" checkout --quiet --detach "$upstream_commit"
cp "$project_root/vendor/alerter-Package.resolved" "$source_dir/Package.resolved"
git -C "$source_dir" apply "$project_root/vendor/alerter-persistent.patch"

SWIFT_DETERMINISTIC_HASHING=1 swift build \
  --package-path "$source_dir" \
  --jobs 1 \
  -Xlinker -ld_classic \
  -c release --arch arm64 --arch x86_64

cp -R "$expected_bundle" "$bundle_dir"
rm -rf "$bundle_dir/Contents/_CodeSignature"
cp "$source_dir/.build/apple/Products/Release/alerter" \
  "$bundle_dir/Contents/MacOS/alerter"
strip -x "$bundle_dir/Contents/MacOS/alerter"
codesign --remove-signature "$bundle_dir/Contents/MacOS/alerter" 2>/dev/null || true
node "$project_root/vendor/normalize-macho-uuids.mjs" \
  "$bundle_dir/Contents/MacOS/alerter"
codesign --force --deep --sign - "$bundle_dir"
codesign --verify --deep --strict "$bundle_dir"

if ! diff -qr "$bundle_dir" "$expected_bundle" >/dev/null; then
  echo 'vendored alerter bundle does not match the pinned-source reproducible build' >&2
  shasum -a 256 \
    "$bundle_dir/Contents/MacOS/alerter" \
    "$expected_bundle/Contents/MacOS/alerter" >&2
  exit 1
fi

echo 'vendored alerter bundle matches the pinned-source reproducible build'
