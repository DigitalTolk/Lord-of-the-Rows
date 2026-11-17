# Releasing Lord of the Rows updates

Lord of the Rows updates through [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/) (v2).
Every update artifact is signed with a **minisign** key; the app embeds the matching public key
(`src-tauri/tauri.conf.json` → `plugins.updater.pubkey`) and refuses to install anything whose
signature does not verify. `requireSignedVersion: true` additionally binds each signature to the
version it was signed for, so a tampered manifest cannot pair a new version number with an older
(validly signed) build.

The **stable** channel reads the manifest of the newest GitHub release,
`https://github.com/DigitalTolk/Lord-of-the-Rows/releases/latest/download/latest.json`, unless
`updates.endpoint.stable` points elsewhere; the **beta** channel has no default
(`updates.endpoint.beta`). The app checks on launch and every 6 hours and, when a newer release is
found, shows an **Update <version>** button in the header that opens Settings → Updates (notes,
Install & restart). Nothing is installed without a click. Turn automatic checks off with
`updates.autoCheck = false` (Settings → Updates).

## macOS releases (what CI does)

`scripts/release-macos.sh` (run by `.github/workflows/release.yml` on a `v*` tag) builds, signs and
notarizes the app, then, from the **stapled** app, writes next to the DMG:

- `LordOfTheRows-<version>-universal.app.tar.gz` and its `.sig` (signed with `--app-version`),
- `latest.json` (notes = the version's `CHANGELOG.md` section; `darwin-aarch64` and
  `darwin-x86_64` both point at the universal tarball).

It then runs `scripts/verify-update-sig.mjs`, which checks the signature against the public key in
`tauri.conf.json` and the version binding, and stops the release if either is wrong.
`scripts/publish-homebrew.sh` uploads the DMG and these three files to the GitHub release, so
`releases/latest/download/latest.json` always describes the newest release.

## Linux releases (what CI does)

`scripts/release-linux.sh` (the `linux` job of the same workflow, on Ubuntu 22.04 so the binaries
need no newer glibc than 2.35) builds the AppImage, `.deb` and `.rpm` for x86_64 and, with the
signing key, signs each with `--app-version`, checks it with `scripts/verify-update-sig.mjs`, and
writes `latest-linux.json` with four platform entries:

| Manifest key | File | Used by |
|---|---|---|
| `linux-x86_64-appimage`, `linux-x86_64` | `LordOfTheRows-<version>-x86_64.AppImage` | AppImage (replaces itself) |
| `linux-x86_64-deb` | `LordOfTheRows-<version>-amd64.deb` | apps installed from the .deb (`dpkg -i` via pkexec) |
| `linux-x86_64-rpm` | `LordOfTheRows-<version>-x86_64.rpm` | apps installed from the .rpm (`rpm -U` via pkexec) |

After the macOS job has published the release, the `linux-publish` job runs
`scripts/publish-linux.sh`: it uploads the packages and signatures, adds a Linux section to the
release notes, and merges the Linux platforms into the release's `latest.json`
(`scripts/merge-manifest.mjs`). `publish-homebrew.sh` merges the same way when it is re-run, so
neither platform drops the other's entries; both stop rather than upload a manifest they could not
merge. `publish-linux.sh` never creates the release: if the macOS job failed before publishing,
the Linux publish fails too, and you re-run the workflow once it's fixed. If the macOS job failed
*after* publishing, the Linux publish still runs; don't re-run the macOS job then (a rebuilt DMG
would no longer match the Homebrew cask's sha256). Between the two publishes (a few minutes),
Linux installs see the new version without a Linux entry and report "no update for this
platform" until the next check.

Locally: `scripts/release-linux.sh && scripts/publish-linux.sh` (after the macOS release).

## Keys

| File | Where | Committed? |
|---|---|---|
| Public key | `src-tauri/tauri.conf.json` `plugins.updater.pubkey` (base64 of the `.pub` file) | yes |
| Private key | outside the repo, e.g. `~/.dbstudio/updater.key` (dev) / CI secret store (release) | **never** |

The key currently in `tauri.conf.json` is a **development/test key** (generated with
`tauri signer generate --ci -w ~/.dbstudio/updater.key`, no password). Before the first public
release, generate a production key **with a password**, store the private key and password in the
CI secret store / a password manager, and replace `pubkey` (see *Rotating the key*).

Generate a key:

```sh
./frontend/node_modules/.bin/tauri signer generate -w ~/.dbstudio/updater.key   # prompts for a password
chmod 600 ~/.dbstudio/updater.key
base64 < ~/.dbstudio/updater.key.pub   # tauri prints this too; it is the value for plugins.updater.pubkey
```

`*.key` files must never be added to git. If a private key is ever committed or leaked, treat it
as compromised and rotate immediately.

## Building signed update artifacts

`bundle.createUpdaterArtifacts` is `true`, so a plain `tauri build` signs the updater artifacts and
**fails if no private key is provided** (the macOS release script turns this off and signs the
stapled app itself, above). Release builds set:

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat /path/to/updater.key)"   # key contents, or a path to the key file
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="…"                     # empty for the dev key
./frontend/node_modules/.bin/tauri build
```

In CI, inject both from the secret store (masked variables); never echo them or write them into
the workspace. `tauri build` embeds the app version in the signature's trusted comment
automatically. When signing an artifact by hand, pass it explicitly — otherwise the app rejects it
(`requireSignedVersion`):

```sh
./frontend/node_modules/.bin/tauri signer sign -f ~/.dbstudio/updater.key --app-version 0.2.0 <artifact>
```

Produced artifacts (each with a `.sig` next to it):

| Platform | Updater artifact | Manifest key(s) |
|---|---|---|
| macOS | `bundle/macos/Lord of the Rows.app.tar.gz` | `darwin-aarch64`, `darwin-x86_64` |
| Windows | `bundle/nsis/*-setup.exe` and/or `bundle/msi/*.msi` | `windows-x86_64` (or `windows-x86_64-nsis` / `-msi`) |
| Linux | `bundle/appimage/*.AppImage`, `bundle/deb/*.deb` | `linux-x86_64-appimage`, `linux-x86_64-deb` (or `linux-x86_64`) |

The updater looks up `{os}-{arch}-{bundle_type}` first, then `{os}-{arch}`.

## Publishing the manifest (stable / beta)

Each channel has its own static `latest.json`, served over **HTTPS** (the app rejects `http`
endpoints in release builds; `http://localhost` is accepted only in debug builds for testing):

```
https://updates.example.com/dbstudio/stable/latest.json
https://updates.example.com/dbstudio/beta/latest.json
```

```json
{
  "version": "0.2.0",
  "notes": "Plain-text release notes shown in Settings → Updates.",
  "pub_date": "2026-11-11T12:00:00Z",
  "platforms": {
    "darwin-aarch64": { "url": "https://updates.example.com/dbstudio/0.2.0/DB.Studio_aarch64.app.tar.gz", "signature": "<contents of the .sig file>" },
    "windows-x86_64": { "url": "https://updates.example.com/dbstudio/0.2.0/DB.Studio_0.2.0_x64-setup.exe", "signature": "<contents of the .sig file>" },
    "linux-x86_64": { "url": "https://updates.example.com/dbstudio/0.2.0/db-studio_0.2.0_amd64.AppImage", "signature": "<contents of the .sig file>" }
  }
}
```

Rules enforced by the app:

- `version` must be valid semver and **strictly newer** than the running version; otherwise the
  app reports "up to date" (no downgrades, no re-installs).
- The **stable** channel ignores pre-release versions (`0.3.0-beta.1`); publish those only to
  the beta manifest. Beta users only read the beta manifest, so publish each stable release
  there too (whenever it is newer than the latest beta).
- `signature` must be the `.sig` contents produced with the private key matching the shipped
  public key **and** the same `version` (`--app-version`). Anything else is rejected before install
  and logged in the audit log as an `app_updated` failure.
- Download URLs should be `https` (the signature protects integrity either way).
- Notes are rendered as plain text (never HTML) and truncated to 64 KiB.

Publish order: upload artifacts first, verify their URLs, then replace `latest.json` atomically
(write to a temp name and rename / single object PUT). Promote a beta to stable by copying the
release entry into `stable/latest.json`.

## Rotating the key

The public key is compiled into each installed app, so rotation is a two-step release:

1. Generate the new key pair. Put the **new** public key in `tauri.conf.json`, build release N,
   and sign release N with the **old** private key (installed apps only trust the old key).
2. Publish release N. From release N+1 on, sign with the **new** private key.

Users who skip release N cannot verify N+1 and must install manually once — keep release N in
the manifest long enough (or document the manual step). If the old key is **compromised**, do the
same immediately, revoke access to the old key everywhere, and announce that releases signed
with the old key after the rotation date are not genuine.

## Verifying a release locally

1. Serve a manifest from `http://localhost:<port>/latest.json` using a debug build (or a real
   HTTPS host for release builds) and set it as the channel endpoint in Settings → Updates.
2. Check now → the new version, notes and Install & restart should appear.
3. Tamper with the artifact (flip a byte) or the manifest `version` and confirm the install is
   rejected with a signature error, the app keeps running, and the audit log shows an
   `app_updated` failure.
