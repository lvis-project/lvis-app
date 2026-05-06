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

For all three platforms, use the **Build Installers** GitHub Actions workflow.
It runs the same `scripts/build-installers.mjs` entrypoint on macOS, Linux,
and Windows runners so native dependencies and installer tooling are resolved
on the target OS instead of relying on cross-platform packaging.

## Smoke-Test Checklist

Perform on each platform artifact before uploading:

- [ ] App launches to the splash screen and transitions to the main window
- [ ] Settings → API 키 입력 → 대화 1 턴 성공
- [ ] Local Indexer, Meeting, LVIS Microsoft 365 plugins list in 설정 → 플러그인
- [ ] 자동 업데이트 설정 토글 동작 (default ON) — 설정 > 일반
- [ ] 크래시 리포트 설정 토글 OFF → 덤프가 `~/.lvis/crash-dumps/` 에만 저장
- [ ] 크래시 리포트 설정 ON + URL 입력 → 테스트 크래시 시 업로드 시도 확인
- [ ] 텔레메트리 OFF 기본값, 대화 여러 턴 후 `endpoint` 에 요청 0건
- [ ] 텔레메트리 ON → 일일 배치 POST 확인 (PII 없음 검증)
- [ ] 오프라인 기동 → 앱 정상 부팅, 자동 업데이트는 조용히 실패

## Rollback Procedure

1. 새 버전에 블로커 발견 시 GitHub Release 즉시 `draft` 로 되돌림
2. `latest.yml` (electron-updater metadata) 를 이전 버전으로 복구 — auto-update
   가 방금 올린 버전을 받지 않도록 차단
3. Slack `#lvis-release` 공지 + Sentry issue triage
4. Hot-fix 브랜치 `hotfix/v<version>` 에서 수정 → 패치 bump → 재릴리스

## Version Pinning Policy

- Electron: 메이저 버전 고정 (`^`). 보안 패치만 주기적 bump.
- electron-updater / electron-builder: minor 고정, patch 자동 (`~`).
- Plugin native deps (better-sqlite3 등): electron-rebuild 재실행 필수 →
  `bun install` postinstall 에서 처리됨.
- Python 런타임: `python-requirements.lock` 파일로 고정. 릴리스마다 변경 diff 검토.

## Publish (Later — NOT part of scaffolding)

When users have completed cert/DSN setup, publish with:

```bash
npx electron-builder --publish=always
```

This pushes artifacts + `latest.yml` to GitHub Releases, where electron-updater
will discover them via the default GitHub provider declared in
`package.json → build.publish`.
