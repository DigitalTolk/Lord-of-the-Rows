#!/usr/bin/env bash
# Local release: Linux x86_64 build as AppImage, .deb and .rpm, each signed for the in-app updater.
#
# Build on the oldest distro you want to support (CI uses Ubuntu 22.04, glibc 2.35): the
# binaries need that glibc or newer. Needs the Tauri system packages (see .github/workflows/ci.yml).
#
# CI: .github/workflows/release.yml runs this same script on a version tag; then
# scripts/publish-linux.sh uploads the files and adds them to the release's latest.json.
#
# Usage:
#   scripts/release-linux.sh                 # build -> ~/Downloads
#   OUT_DIR=dist scripts/release-linux.sh
#   SKIP_BUILD=1 scripts/release-linux.sh    # reuse the last build
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="${OUT_DIR:-$HOME/Downloads}"
VERSION="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
REPO_URL="https://github.com/DigitalTolk/Lord-of-the-Rows"
BUNDLE="target/release/bundle"
[ "$(uname -s)" = Linux ] || { echo "Run this on Linux" >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "Only x86_64 Linux builds are released" >&2; exit 1; }

# Updater signing key: CI secret, else the local key file. Without one, installed apps aren't offered this release.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
elif [ -f "$HOME/.dbstudio/updater.key" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.dbstudio/updater.key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
fi

if [ -z "${SKIP_BUILD:-}" ]; then
  echo "==> Building frontend"
  (cd frontend && npm ci --no-fund --silent && npx vite build)
  # Update signatures are made below with the version bound (requireSignedVersion), not by tauri build.
  CFG='{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":false}}'
  echo "==> Building AppImage, .deb and .rpm"
  rm -rf "$BUNDLE/appimage" "$BUNDLE/deb" "$BUNDLE/rpm"
  ./frontend/node_modules/.bin/tauri build --bundles appimage,deb,rpm --config "$CFG"
fi

one() {
  local found=("$BUNDLE"/$1)
  [ ${#found[@]} -eq 1 ] && [ -f "${found[0]}" ] || { echo "Expected exactly one $BUNDLE/$1 for $VERSION" >&2; exit 1; }
  echo "${found[0]}"
}
mkdir -p "$OUT_DIR"
# Stable names: <kind> -> file in OUT_DIR. The kind is also the updater's installer name.
declare -A FILES=(
  [appimage]="LordOfTheRows-$VERSION-x86_64.AppImage"
  [deb]="LordOfTheRows-$VERSION-amd64.deb"
  [rpm]="LordOfTheRows-$VERSION-x86_64.rpm"
)
cp "$(one "appimage/*_${VERSION}_amd64.AppImage")" "$OUT_DIR/${FILES[appimage]}"
cp "$(one "deb/*_${VERSION}_amd64.deb")" "$OUT_DIR/${FILES[deb]}"
cp "$(one "rpm/*-${VERSION}-1.x86_64.rpm")" "$OUT_DIR/${FILES[rpm]}"
chmod +x "$OUT_DIR/${FILES[appimage]}"

MANIFEST="$OUT_DIR/latest-linux.json"
rm -f "$MANIFEST" "$OUT_DIR"/LordOfTheRows-"$VERSION"-*.sig
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "==> Update signatures (signed for $VERSION)"
  for kind in appimage deb rpm; do
    f="$OUT_DIR/${FILES[$kind]}"
    ./frontend/node_modules/.bin/tauri signer sign --app-version "$VERSION" "$f" >/dev/null
    # Fail now (not on every user's machine) if the key doesn't match the one the app trusts.
    node scripts/verify-update-sig.mjs "$f" "$f.sig" "$VERSION"
  done
  # Linux-only manifest; publish-linux.sh merges its platforms into the release's latest.json.
  # The updater looks for "linux-x86_64-<installer>" first (the format the app was installed
  # from: an AppImage replaces itself, .deb/.rpm install through pkexec), then "linux-x86_64".
  awk -v v="## $VERSION" '$0==v{f=1;next} /^## /{if(f)exit} f' CHANGELOG.md > "$OUT_DIR/.notes.md"
  BASE="$REPO_URL/releases/download/v$VERSION" OUT="$OUT_DIR" VERSION="$VERSION" NOTES_FILE="$OUT_DIR/.notes.md" \
  APPIMAGE="${FILES[appimage]}" DEB="${FILES[deb]}" RPM="${FILES[rpm]}" \
    node -e '
      const fs = require("fs");
      const e = process.env;
      const asset = (f) => ({ signature: fs.readFileSync(`${e.OUT}/${f}.sig`, "utf8").trim(), url: `${e.BASE}/${f}` });
      const m = {
        version: e.VERSION,
        notes: fs.readFileSync(e.NOTES_FILE, "utf8").trim(),
        pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        platforms: {
          "linux-x86_64": asset(e.APPIMAGE),
          "linux-x86_64-appimage": asset(e.APPIMAGE),
          "linux-x86_64-deb": asset(e.DEB),
          "linux-x86_64-rpm": asset(e.RPM),
        },
      };
      fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2) + "\n");
    ' "$MANIFEST"
  rm -f "$OUT_DIR/.notes.md"
else
  echo "==> No updater signing key: skipping the in-app update signatures"
fi

echo "==> Done:"
ls -1 "$OUT_DIR"/LordOfTheRows-"$VERSION"-{x86_64.AppImage,amd64.deb,x86_64.rpm}*
