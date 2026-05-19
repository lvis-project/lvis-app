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

**기대 asset (11종, v0.2.1 기준)**:
- Linux: `LVIS-X.Y.Z-linux-amd64.deb`, `LVIS-X.Y.Z-linux-x86_64.AppImage`, `LVIS-X.Y.Z-linux-x86_64.rpm`, `latest-linux.yml`
- Mac arm64: `LVIS-X.Y.Z-mac-arm64.dmg` + `.blockmap`, `LVIS-X.Y.Z-mac-arm64.zip`, `latest-mac.yml`
- Windows: `LVIS-X.Y.Z-windows-x64-setup.exe`, `LVIS-X.Y.Z-win-x64.zip`, `latest.yml`

### 6. Release body + publish

CHANGELOG entry 를 release body 로:

```bash
awk '/^## vX.Y.Z/{flag=1} /^---$/{if(flag){flag=0; exit}} flag' CHANGELOG.md \
  | gh release edit vX.Y.Z -R lvis-project/lvis-app --notes-file - --draft=false
```

## Partial release 복구

electron-builder publisher 가 race / timeout 으로 일부 asset 만 upload 한 경우 (`mac-arm64.dmg.blockmap` 만 있고 본체 없음 등):

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

## 알려진 정책 / 한계

- **Mac x64 (Intel) 미산출 — intentional**. CI runner = macOS arm64. Apple Silicon Mac 만 공식 지원.
- **`[DEFAULT_BRANCH_DIRECT_PUSH]` guard 가 main 직접 push 차단** — release bump 도 예외 없이 PR 강제. dev-tools PR #14 가 도입한 정책.
- **electron-builder publish race** — 3 platform job 이 같은 draft 에 동시 publish, GitHub API atomic 미보장 → partial 가능. 위 "Partial release 복구" 절차로 보강.
- **Tag dereference 주의** — annotated tag 의 `git ls-remote` 결과는 *tag object SHA*. commit SHA 보려면 `refs/tags/vX.Y.Z^{}`.

## 자주 발생하는 함정

- **multi-repo workspace 의 shell cwd drift** — `cd` 가 Bash session 에서 persist. release 작업 중 다른 sibling repo (예: dev-tools) 로 우연히 이동하면 `git remote set-url` 같은 명령이 잘못된 repo 에 적용. 모든 git 명령은 `git -C <abs-path>` 형태로 격리.
- **`Node.js vXX.0.0` footer 오독** — Node 가 throw 시 stack trace 끝에 *반드시* 버전 라인을 찍음. 진짜 error 의 *첫 줄* 을 확인. "Node 버전 호환 issue" 가 아니라 *MODULE_NOT_FOUND* 나 정책 violation 인 경우 다수.
