# Build

## Linux (Docker, used for development and tests)
```sh
docker compose build dev
docker compose run --rm dev sh -c 'cd frontend && npm ci && npx vite build && cd .. && cargo build -p dbstudio --release --features custom-protocol'
```

## Linux packages (AppImage, .deb, .rpm)
Natively on Linux x86_64 with Rust stable, Node 22 and the Tauri system packages (Debian/Ubuntu:
`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libdbus-1-dev libxdo-dev pkg-config file libfuse2`;
Fedora: `webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel openssl-devel dbus-devel libxdo-devel fuse-libs`):
```sh
OUT_DIR=dist scripts/release-linux.sh
```
Output: `dist/LordOfTheRows-<version>-{x86_64.AppImage,amd64.deb,x86_64.rpm}` (plus `.sig` files and
`latest-linux.json` when `TAURI_SIGNING_PRIVATE_KEY` is set). The binaries need the build host's glibc
or newer, so release builds run on Ubuntu 22.04.

## macOS (native, unsigned)
Requires Xcode Command Line Tools, Rust (`brew install rustup && rustup default stable && rustup target add x86_64-apple-darwin aarch64-apple-darwin`) and Node (`brew install node`).
```sh
cd frontend && npm ci && npx vite build && cd ..
# If your Command Line Tools linker is older than the default SDK ("unknown architecture arm64e.x1"), pin a matching SDK:
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
./frontend/node_modules/.bin/tauri build --target universal-apple-darwin --bundles app,dmg --config '{"build":{"beforeBuildCommand":""}}'
```
Output: `target/universal-apple-darwin/release/bundle/{macos,dmg}/`.
If the DMG step fails with `hdiutil: couldn't unmount … Resource busy` (Finder/Spotlight holding the temporary
image), build the DMG directly:
```sh
STAGE=$(mktemp -d); cp -R "target/universal-apple-darwin/release/bundle/macos/Lord of the Rows.app" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Lord of the Rows" -srcfolder "$STAGE" -ov -format UDZO "Lord of the Rows_0.1.0_universal_unsigned.dmg"
```
Verified 2026-11-11: universal (x86_64 + arm64) app, 60 MB; DMG 27 MB; launches on macOS 27.2 (Apple Silicon). The build is **unsigned**; signing/notarization
needs an Apple Developer ID (see RELEASE notes in BLOCKERS.md).

## CI
`.github/workflows/ci.yml`: fmt, clippy, Rust tests with DB services, frontend checks, full E2E in Docker, security
scans + SBOM, unsigned universal macOS DMG artifact, Linux AppImage / .deb / .rpm artifact.
`.github/workflows/release.yml`: signed + notarized macOS release and the Linux packages, on a `v*` tag.
