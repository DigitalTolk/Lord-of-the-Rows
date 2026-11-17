#!/usr/bin/env bash
# Builds the Linux or Windows release bundles, signs each in-app update artifact for this
# version, checks the signatures against the key the app trusts, and writes the files with
# stable names into $OUT_DIR, plus a manifest fragment (platforms-<os>-<arch>.json) that the
# release workflow merges into latest.json.
#
#   scripts/release-desktop.sh linux     # .AppImage, .deb, .rpm  (run on Linux, native arch)
#   scripts/release-desktop.sh windows   # NSIS -setup.exe, per-user install (run on Windows, Git Bash)
#
# Env: TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD) to make update artifacts; without it the
# installers are still built but no manifest fragment is written.
# macOS has its own script (release-macos.sh: universal build, Developer ID, notarization).
set -euo pipefail
cd "$(dirname "$0")/.."

OS="${1:?usage: release-desktop.sh linux|windows}"
VERSION="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
REPO_URL="https://github.com/DigitalTolk/Lord-of-the-Rows"
OUT_DIR="${OUT_DIR:-$PWD/dist}"
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x86_64 DEB_ARCH=amd64 ;;
  aarch64 | arm64) ARCH=aarch64 DEB_ARCH=arm64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
case "$OS" in
  linux) BUNDLES=deb,rpm,appimage ;;
  windows) BUNDLES=nsis ;;
  *) echo "unknown OS $OS (linux|windows)" >&2; exit 1 ;;
esac

echo "==> Frontend"
(cd frontend && npm ci --no-fund --silent && npx vite build)

echo "==> Building $OS $ARCH ($BUNDLES) $VERSION"
# Update artifacts are signed below with the version bound in (requireSignedVersion), as on macOS.
CFG='{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":false}}'
./frontend/node_modules/.bin/tauri build --bundles "$BUNDLES" --config "$CFG"
BUNDLE_DIR="${CARGO_TARGET_DIR:-target}/release/bundle"

mkdir -p "$OUT_DIR"
# copy <glob> <stable name>
copy() {
  local src
  src="$(ls $1 2>/dev/null | head -1)"
  [ -n "$src" ] || { echo "missing bundle: $1" >&2; exit 1; }
  cp "$src" "$OUT_DIR/$2"
  echo "    $2"
}
FILES=()  # "<manifest key>=<file name>"
if [ "$OS" = linux ]; then
  APPIMAGE="LordOfTheRows-$VERSION-linux-$ARCH.AppImage"
  DEB="LordOfTheRows-$VERSION-linux-$DEB_ARCH.deb"
  RPM="LordOfTheRows-$VERSION-linux-$ARCH.rpm"
  copy "$BUNDLE_DIR/appimage/*.AppImage" "$APPIMAGE"
  copy "$BUNDLE_DIR/deb/*.deb" "$DEB"
  copy "$BUNDLE_DIR/rpm/*.rpm" "$RPM"
  chmod +x "$OUT_DIR/$APPIMAGE"
  # The updater looks up "<os>-<arch>-<installer>" first, so each install type updates with
  # its own package; plain "linux-<arch>" (older updaters) gets the AppImage.
  FILES=("linux-$ARCH-appimage=$APPIMAGE" "linux-$ARCH-deb=$DEB" "linux-$ARCH-rpm=$RPM" "linux-$ARCH=$APPIMAGE")
else
  SETUP="LordOfTheRows-$VERSION-windows-$ARCH-setup.exe"
  copy "$BUNDLE_DIR/nsis/*-setup.exe" "$SETUP"
  FILES=("windows-$ARCH-nsis=$SETUP" "windows-$ARCH=$SETUP")
fi

FRAGMENT="$OUT_DIR/platforms-$OS-$ARCH.json"
rm -f "$FRAGMENT"
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "==> No updater signing key: installers only, no in-app update entries"
  exit 0
fi

echo "==> Signing update artifacts for $VERSION"
declare -A SIGNED=()
for entry in "${FILES[@]}"; do
  f="${entry#*=}"
  [ -n "${SIGNED[$f]:-}" ] && continue
  ./frontend/node_modules/.bin/tauri signer sign --app-version "$VERSION" "$OUT_DIR/$f" >/dev/null
  # Fail here, not on every user's machine, if the key isn't the one the app trusts.
  node scripts/verify-update-sig.mjs "$OUT_DIR/$f" "$OUT_DIR/$f.sig" "$VERSION"
  SIGNED[$f]=1
done

BASE="$REPO_URL/releases/download/v$VERSION" DIR="$OUT_DIR" node -e '
  const fs = require("fs"), path = require("path");
  const out = {};
  for (const e of process.argv.slice(2)) {
    const [key, file] = e.split("=");
    out[key] = { url: `${process.env.BASE}/${file}`, signature: fs.readFileSync(path.join(process.env.DIR, file + ".sig"), "utf8").trim() };
  }
  fs.writeFileSync(process.argv[1], JSON.stringify(out, null, 2) + "\n");
' "$FRAGMENT" "${FILES[@]}"
echo "==> Wrote $(basename "$FRAGMENT")"
