#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
expected_root=${OPENMERGELENS_EXPECTED_ROOT:-$project_root}
upstream_commit=8efbb0e977f57d7430e8f1e42e874a426080a8f3
expected_xcode_version='Xcode 26.3'
default_developer_dir=/Applications/Xcode_26.3.app/Contents/Developer
work_root=$(mktemp -d "${TMPDIR:-/tmp}/openmergelens-terminal-notifier.XXXXXX")
source_dir="$work_root/source"
build_dir="$work_root/build"

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

git clone --quiet https://github.com/julienXX/terminal-notifier.git "$source_dir"
git -C "$source_dir" checkout --quiet --detach "$upstream_commit"
xcodebuild -quiet \
  -project "$source_dir/Terminal Notifier.xcodeproj" \
  -scheme 'Terminal Notifier' \
  -configuration Release \
  ARCHS='x86_64 arm64' \
  ONLY_ACTIVE_ARCH=NO \
  MACOSX_DEPLOYMENT_TARGET=11.0 \
  CODE_SIGNING_ALLOWED=NO \
  -derivedDataPath "$build_dir" \
  build

rebuilt="$build_dir/Build/Products/Release/terminal-notifier.app/Contents/MacOS/terminal-notifier"
strip -x "$rebuilt"
codesign --remove-signature "$rebuilt" 2>/dev/null || true
node "$project_root/vendor/normalize-macho-uuids.mjs" "$rebuilt"
codesign --force --sign - "$rebuilt"

if ! cmp -s \
  "$rebuilt" \
  "$expected_root/vendor/terminal-notifier.app/Contents/MacOS/terminal-notifier"; then
  echo 'vendored terminal-notifier does not match the pinned-source reproducible build' >&2
  shasum -a 256 \
    "$rebuilt" \
    "$expected_root/vendor/terminal-notifier.app/Contents/MacOS/terminal-notifier" >&2
  exit 1
fi

echo 'vendored terminal-notifier matches the pinned-source reproducible build'
