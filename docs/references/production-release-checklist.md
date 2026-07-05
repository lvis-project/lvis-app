# Production Release Checklist

Scaffold-only reference for cutting an LVIS production release. The release
machinery (`scripts/release.mjs` + `electron-builder`) is wired; the items
below are the manual operator steps.

## Prerequisites

Set the following environment variables before running the release script:

| Variable | Purpose | Required |
|----------|---------|----------|
| `CSC_LINK` / `CSC_KEY_PASSWORD` | macOS code-signing cert (p12) | macOS builds |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | macOS notarization | macOS builds |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows code-signing cert | Windows builds |
| `GH_TOKEN` | GitHub Releases upload token (`repo` scope) | Publish |
| `LVIS_PUBLISHER_PRIVATE_KEY_PATH` | Plugin manifest signing key (Ed25519 PEM) | Plugin signing |
| `LVIS_SENTRY_DSN` | Forward crashes to Sentry (optional) | Optional |
| `LVIS_RELEASE_VERSION` | Explicit version (otherwise patch-bump) | Optional |

None of these are checked in. They come from the release operator.

## Build Steps

```bash
# 1. Clean slate
git checkout main && git pull
rm -rf dist release node_modules/.cache

# 2. Install
bun install

# 3. Cut release (bumps patch, builds, runs the native installer target)
bun run release

# Output: release/LVIS-<version>-<platform>-<arch>...
```

For local installer builds without a version bump:

```bash
bun run dist                     # current OS installer
bun run dist:current             # current OS installer
bun run dist:mac                 # macOS DMG + ZIP, run on macOS
bun run dist:linux               # AppImage + DEB + RPM, run on Linux
bun run dist:win                 # NSIS + ZIP, run on Windows
```

For fast internal preview builds:

```bash
bun run dist:fast                # current OS, writes release-fast/
bun run dist:mac:fast            # macOS preview DMG + ZIP, larger files
bun run dist:linux:fast          # Linux preview AppImage + DEB + RPM, larger files
bun run dist:win:fast            # Windows preview NSIS + ZIP, larger files
```

Fast preview mode is only for quick QA links while a PR is still moving. It
passes `compression=store` and `npmRebuild=false` to `electron-builder`, writes
to `release-fast/`, and refuses `--publish`. Keep normal `dist:*` / `release`
commands for public release assets because they retain size-optimized normal
compression.

Measured on 2026-05-15 for `lvis-app` 0.1.3 on macOS arm64:

| Command | Time | Artifact size |
| --- | ---: | ---: |
| `bun run build` | 2.61s | n/a |
| `build-installers --mac --skip-build --skip-code-sign --dir` | 8.67s | unpacked only |
| same with `-c.npmRebuild=false` | 6.12s | unpacked only |
| normal `--mac --skip-build --skip-code-sign` | 45.73s | DMG 106M / ZIP 103M |
| fast preview equivalent | 16.99s | DMG 227M / ZIP 226M |

Use `--skip-native-rebuild` only immediately after `bun install` or another
known-good native dependency rebuild. It avoids the duplicate
`better-sqlite3` rebuild that `electron-builder` performs by default, without
changing artifact compression or size.

For all three platforms, use the **Build Installers** GitHub Actions workflow.
It runs the same `scripts/build-installers.mjs` entrypoint on macOS, Linux,
and Windows runners so native dependencies and installer tooling are resolved
on the target OS instead of relying on cross-platform packaging. The publish
job also attaches `LVIS-latest-*` stable alias assets for the website download
links; do not publish a release that only has versioned `LVIS-X.Y.Z-*` assets.

## Smoke-Test Checklist

Perform on each platform artifact before uploading:

- [ ] App launches to the splash screen and transitions to the main window
- [ ] Settings -> API key entry -> one chat turn succeeds
- [ ] Local Indexer, Meeting, and LVIS Microsoft 365 plugins are listed in Settings -> Plugins
- [ ] Auto-update settings toggle works (default ON) in Settings -> General
- [ ] Crash reporting OFF -> dumps are stored only in `~/.lvis/crash-dumps/`
- [ ] Crash reporting ON + URL configured -> test crash attempts upload
- [ ] Telemetry default OFF -> after several chat turns, `endpoint` receives zero requests
- [ ] Telemetry ON -> daily batch POST is observed and verified to contain no PII
- [ ] Offline startup -> app boots normally and auto-update fails quietly

## Rollback Procedure

1. If a blocker is found in the new version, immediately move the GitHub Release back to `draft`
2. Restore `latest.yml` (electron-updater metadata) to the previous version so auto-update does not receive the just-published build
3. Announce in Slack `#lvis-release` and triage Sentry issues
4. Fix from `hotfix/v<version>`, bump patch, and re-release

## Version Pinning Policy

- Electron: pin the major version (`^`) and periodically bump security patches.
- electron-updater / electron-builder: pin minor, allow automatic patch updates (`~`).
- Plugin native deps (for example `better-sqlite3`): rerun electron-rebuild; `bun install` handles this in postinstall.
- Python runtime: pin shared envs by host-managed Python plugin lockfile content plus OS/arch. For every release, review the active plugin lockfile diff and packaged asset boundary (include uv, exclude venv/wheelhouse/model cache).

## Publish (Later — NOT part of scaffolding)

When users have completed cert/DSN setup, publish with:

```bash
npx electron-builder --publish=always
```

This pushes artifacts + `latest.yml` to GitHub Releases, where electron-updater
will discover them via the default GitHub provider declared in
`package.json → build.publish`.
