#!/usr/bin/env bash
# Add the Linux build to the GitHub release that publish-homebrew.sh created (run that
# first: it writes the release notes and the macOS half of latest.json), and merge the
# Linux platforms into the release's latest.json.
#
#   scripts/release-linux.sh          # builds ~/Downloads/LordOfTheRows-<version>-{x86_64.AppImage,amd64.deb,x86_64.rpm}
#   scripts/publish-linux.sh          # uploads them + merges latest-linux.json into the release's latest.json
#
# OUT_DIR: where release-linux.sh wrote the files (default ~/Downloads).
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="DigitalTolk/Lord-of-the-Rows"
VERSION="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
TAG="v$VERSION"
DIR="${OUT_DIR:-$HOME/Downloads}"
PKGS=("$DIR/LordOfTheRows-$VERSION-x86_64.AppImage" "$DIR/LordOfTheRows-$VERSION-amd64.deb" "$DIR/LordOfTheRows-$VERSION-x86_64.rpm")
for f in "${PKGS[@]}"; do
  [ -f "$f" ] || { echo "Missing $f (run scripts/release-linux.sh first)" >&2; exit 1; }
done
ASSETS=("${PKGS[@]}")
for f in "${PKGS[@]}"; do
  [ -f "$f.sig" ] && ASSETS+=("$f.sig")
done
[ -f "$DIR/latest-linux.json" ] || echo "    (no latest-linux.json: installed Linux apps won't be offered this release)"
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login" >&2; exit 1; }

SECTION="### Linux (x86_64)
AppImage (any distro, updates itself in the app): \`chmod +x LordOfTheRows-$VERSION-x86_64.AppImage\` and run it.
Debian / Ubuntu: \`sudo apt install ./LordOfTheRows-$VERSION-amd64.deb\`
Fedora / RHEL / openSUSE: \`sudo dnf install ./LordOfTheRows-$VERSION-x86_64.rpm\`
Needs glibc 2.35+ (Ubuntu 22.04, Debian 12, Fedora 36 or newer). Saved passwords go to the Secret Service (GNOME Keyring / KWallet).

SHA-256:
\`\`\`
$(cd "$DIR" && sha256sum "${PKGS[@]##*/}")
\`\`\`"

echo "==> GitHub release $TAG"
# Fails (instead of creating a Linux-only release) until publish-homebrew.sh has published it.
ASSET_NAMES="$(gh release view "$TAG" --repo "$REPO" --json assets -q '.assets[].name')" \
  || { echo "Release $TAG not found: publish the macOS release first (scripts/publish-homebrew.sh)" >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [ -f "$DIR/latest-linux.json" ]; then
  # Merge before uploading anything. A failed download stops here rather than replacing
  # the release's latest.json with a Linux-only one.
  if grep -qx latest.json <<<"$ASSET_NAMES"; then
    gh release download "$TAG" --repo "$REPO" --pattern latest.json --dir "$TMP"
  fi
  node scripts/merge-manifest.mjs "$TMP/latest.json" "$DIR/latest-linux.json"
fi
gh release upload "$TAG" "${ASSETS[@]}" --repo "$REPO" --clobber
BODY="$(gh release view "$TAG" --repo "$REPO" --json body -q .body)"
# Replace an earlier Linux section (a re-run) instead of adding a second one; tolerate CRLF
# (bodies edited on github.com).
BODY="$(printf '%s\n' "$BODY" | awk '{sub(/\r$/, "")} /^### Linux \(x86_64\)$/{exit} {print}')"
printf '%s\n\n%s\n' "$BODY" "$SECTION" > "$TMP/notes.md"
gh release edit "$TAG" --repo "$REPO" --notes-file "$TMP/notes.md"
if [ -f "$TMP/latest.json" ]; then
  echo "==> Adding the Linux platforms to latest.json"
  gh release upload "$TAG" "$TMP/latest.json" --repo "$REPO" --clobber
fi

echo "==> Done: $TAG"
