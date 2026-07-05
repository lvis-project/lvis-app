# Release Process

LVIS app 의 release 발행 절차. `[DEFAULT_BRANCH_DIRECT_PUSH]` guard 와 electron-builder GitHub publisher 의 alignment 를 다룸.

## 정합 flow (요약)

1. **Release branch + PR** — main 직접 push 는 dev-tools 의 pre-push hook 이 거부 (`[DEFAULT_BRANCH_DIRECT_PUSH]`). 모든 release commit 은 `chore/release-vX.Y.Z` branch 통해 PR 머지.
2. **Tag 는 release commit 에 anchored**. annotated tag (`git tag -a vX.Y.Z -m "..."`) 권장.
3. **Build Installers workflow 가 tag push 로만 trigger** (`on: push: tags: ['v*']`). main push 로는 자동 실행 안 됨.
4. **Workflow artifact + GitHub Release asset 은 별개 publishing channel**. electron-builder 가 `--publish always` flag 로 release 에 직접 upload.

## 단계별

### 1. Version bump + CHANGELOG

```bash
# lvis-app 워크트리에서 (절대경로 권장)
cd /path/to/lvis-app
# package.json version 수동 또는 bun run release script
# CHANGELOG.md 에 새 entry prepend
```

### 2. Release branch + tag

```bash
git switch -c chore/release-v0.2.1
git add package.json CHANGELOG.md
git commit -m "chore(release): v0.2.1 — <one-line summary>"
git tag -a v0.2.1 -m "LVIS v0.2.1 — <summary>"
```

### 3. Push branch + tag

```bash
git push -u origin chore/release-v0.2.1
git push origin v0.2.1
```

Tag push 가 **Build Installers** workflow trigger.

### 4. PR open + 머지

```bash
gh pr create --title "chore(release): v0.2.1" --base main --head chore/release-v0.2.1 --body "..."
```

- CI clean (`mergeStateStatus = CLEAN`) 확인
- `gh pr merge <N> --merge --delete-branch` — **squash 금지** (tag 가 가리키는 commit SHA 보존)
- 머지 후 `git -C <abs> pull --ff-only origin main` 으로 local 정합

### 5. Release asset 검증

Build Installers workflow 완료 후:

```bash
gh release view vX.Y.Z -R lvis-project/lvis-app --json assets -q '[.assets[].name]'
```

**기대 asset (23종 = version/update metadata 13 + stable alias 10)**:
- Linux: `LVIS-X.Y.Z-linux-amd64.deb`, `LVIS-X.Y.Z-linux-x86_64.AppImage`, `LVIS-X.Y.Z-linux-x86_64.rpm`, `latest-linux.yml`
- Mac arm64: `LVIS-X.Y.Z-mac-arm64.dmg` + `.blockmap`, `LVIS-X.Y.Z-mac-arm64.zip` + `.blockmap`, `latest-mac.yml`
- Windows: `LVIS-X.Y.Z-windows-x64-setup.exe` + `.blockmap`, `LVIS-X.Y.Z-win-x64.zip`, `latest.yml`
- Stable website aliases: matching `LVIS-latest-*` copies for each installer/archive and `.blockmap`.

### 6. Release body + publish

CHANGELOG entry 를 release body 로:

```bash
awk '/^## vX.Y.Z/{flag=1} /^---$/{if(flag){flag=0; exit}} flag' CHANGELOG.md \
  | gh release edit vX.Y.Z -R lvis-project/lvis-app --notes-file - --draft=false
```

## Partial release 복구 (legacy — v0.2.3+ 부터 자동 해소)

> **Note (v0.2.3+)**: Workflow 가 *atomic single-publish job* 으로 재설계됨 (PR #1047 이후). matrix 3 job 이 동시에 같은 Release 에 publish 하던 race 가 사라져, partial asset 사고 자체가 발생하지 않음. 이 절차는 v0.2.1 / v0.2.2 release 사이클의 *historic mitigation* — 다시 사용 안 함.

(legacy) electron-builder publisher 가 race / timeout 으로 일부 asset 만 upload 한 경우:

1. **누락 식별** — 위 5번의 asset list 와 비교
2. **Workflow artifact 직접 다운로드**:
   ```bash
   gh run download <run-id> -R lvis-project/lvis-app --dir /tmp/v021 --name lvis-win-installers
   ```
3. **Release 에 manual upload**:
   ```bash
   gh release upload vX.Y.Z /tmp/v021/*.exe /tmp/v021/latest.yml -R lvis-project/lvis-app
   ```

partial asset 삭제 후 workflow re-run 방식도 가능하지만, **electron-builder publisher 는 기존 asset 있으면 skip** — re-run 단독으로는 누락 보충 안 됨.

### 새 atomic publish flow (현재)

`.github/workflows/build-installers.yml`:
- `installers` matrix job: 3 platform 각각 build + smoke + `actions/upload-artifact` (no GH publish)
- `publish-release` single job (`needs: installers`, `if: tag-push only`): 모든 platform artifact `actions/download-artifact` → `softprops/action-gh-release` 으로 atomic upload

→ partial 발생 불가능. 사고 시 *workflow re-run* 만으로 충분.

## 알려진 정책 / 한계

- **Mac x64 (Intel) 미산출 — intentional**. CI runner = macOS arm64. Apple Silicon Mac 만 공식 지원.
- **`[DEFAULT_BRANCH_DIRECT_PUSH]` guard 가 main 직접 push 차단** — release bump 도 예외 없이 PR 강제. dev-tools PR #14 가 도입한 정책.
- **electron-builder publish race (resolved v0.2.3+)** — 과거 matrix publish 경로의 historic incident. 현재는 single publish job 이므로 운영 한계가 아니라 legacy 복구 참고만 유지.
- **Tag dereference 주의** — annotated tag 의 `git ls-remote` 결과는 *tag object SHA*. commit SHA 보려면 `refs/tags/vX.Y.Z^{}`.

## 공개/외부 빌드 — 임베디드 데모 활성화 키 금지 (#1498)

`scripts/build-main-esbuild.mjs` 는 `LVIS_EMBED_DEMO_ACTIVATION` env 또는 gitignored
repo-root `.env.demo` 로부터 데모 활성화 키를 빌드타임에 번들에 임베드할 수 있다 (사내
Azure Foundry 데모 endpoint 로 무입력 인증). 이 안전 모델은 그 endpoint 가 사내망에서만
도달 가능(host-resolver-rules)하다는 전제에 전적으로 의존한다 — 외부 audience 가 받는
빌드에 같은 키를 임베드하면 codec 의 2-factor 전달 모델이 1-factor 로 붕괴한다.

- `LVIS_DISTRIBUTION_CHANNEL` 이 이 신호의 SOT. 미설정 시 기본값 `internal` — 기존
  사내/CI/dev 빌드는 전부 무회귀.
- `LVIS_DISTRIBUTION_CHANNEL=public` 인 상태에서 `LVIS_EMBED_DEMO_ACTIVATION` 또는
  repo-root `.env.demo` 가 환경에 존재하면 embed 해석 이전에 즉시 빌드 fail
  (`process.exit(1)`).
- 공개/외부 릴리스 파이프라인은 `LVIS_DISTRIBUTION_CHANNEL=public` 을 설정하고 두 embed
  소스 모두 제공하지 않아야 한다. 우회 옵션 없음 — silent downgrade 후 계속 진행하지
  않고 항상 빌드를 막는다.
- 구현: `scripts/build-main-esbuild.mjs` 의 `assertNoPublicEmbed`. Threat model 은
  `src/main/demo-embedded-activation.ts` 참조.

## 자주 발생하는 함정

- **multi-repo workspace 의 shell cwd drift** — `cd` 가 Bash session 에서 persist. release 작업 중 다른 sibling repo (예: dev-tools) 로 우연히 이동하면 `git remote set-url` 같은 명령이 잘못된 repo 에 적용. 모든 git 명령은 `git -C <abs-path>` 형태로 격리.
- **`Node.js vXX.0.0` footer 오독** — Node 가 throw 시 stack trace 끝에 *반드시* 버전 라인을 찍음. 진짜 error 의 *첫 줄* 을 확인. "Node 버전 호환 issue" 가 아니라 *MODULE_NOT_FOUND* 나 정책 violation 인 경우 다수.
