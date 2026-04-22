# LVIS — Windows (사내망) 설치 & 실행 가이드

사내망 Windows PC 에서 LVIS 를 처음부터 실행까지 끝내는 원스톱 가이드.
`npm run start:npm` 한 방으로 뜨도록 host 가 GPU flag / UTF-8 / 환경변수를
자동 주입하므로, 이 문서의 절차만 따르면 추가 세팅이 필요 없다.

## 0. 사전 요구사항

| 항목 | 최소 버전 | 확인 |
|------|----------|------|
| Node.js | 18+ (20 LTS 권장) | `node -v` |
| npm | 9+ | `npm -v` |
| Git | 2.30+ | `git --version` |

터미널은 **PowerShell**, **Windows Terminal**, **cmd** 모두 OK.
bun 은 선택사항 — `start:npm` 계열 스크립트는 bun 없이도 전부 동작.

## 1. 저장소 clone (6개 레포)

LVIS 는 host 1개 + 플러그인 5개가 **같은 부모 디렉터리에 나란히** 있어야 한다
(`file:../lvis-plugin-*` 참조 때문).

```powershell
mkdir lvis-project
cd lvis-project

git clone --recurse-submodules https://github.com/lvis-project/lvis-app.git
git clone https://github.com/lvis-project/lvis-plugin-pageindex.git
git clone https://github.com/lvis-project/lvis-plugin-meeting.git
git clone https://github.com/lvis-project/lvis-plugin-email.git
git clone https://github.com/lvis-project/lvis-plugin-calendar.git
git clone https://github.com/lvis-project/lvis-plugin-lge-api.git
```

완성된 구조:

```
lvis-project/
├── lvis-app/                ← host (여기서 빌드·실행)
├── lvis-plugin-pageindex/
├── lvis-plugin-meeting/
├── lvis-plugin-email/
├── lvis-plugin-calendar/
└── lvis-plugin-lge-api/
```

> `lvis-app` 은 `--recurse-submodules` 플래그 필수.
> `packages/plugin-sdk` 가 submodule 이기 때문.

## 2. 설치

```powershell
cd lvis-app
npm install --legacy-peer-deps --install-links=true
```

### `--install-links=true` 필수 이유

Windows 는 non-admin 계정에서 symlink 생성이 제한된다. npm 기본 동작은
`file:../lvis-plugin-*` 같은 파일 의존성을 symlink 로 설치하려고 하는데,
이 때 `EISDIR / errno -4068` 에러가 난다. `--install-links=true` 는 symlink
대신 **copy 모드**로 설치해서 이 문제를 회피한다.

### postinstall 자동 처리

`scripts/ensure-submodules.mjs` 가 다음을 자동으로 수행:

1. `packages/plugin-sdk` submodule 이 비어있으면
   `git submodule update --init --recursive`
2. submodule 이 `package.json` 은 있지만 `dist/` 가 없으면
   `npm install && npm run build` 실행
3. `node_modules/@lvis/plugin-sdk/dist` 가 실-디렉터리 copy 이면,
   방금 빌드한 dist 를 그곳으로 sync (Windows `--install-links=true` 순서 문제 해결)

### 설치 확인

```powershell
dir node_modules\@lvis\plugin-sdk\dist\keys.js
```

`keys.js` 파일이 찍혀야 정상. 안 찍히면 [5. 문제 해결](#5-문제-해결)
의 "Cannot find module '@lvis/plugin-sdk/keys'" 참고.

## 3. 실행

```powershell
npm run start:npm
```

PowerShell 에서 `[Console]::OutputEncoding` 캐시 문제로 한글이 깨지는 케이스에는
PowerShell launcher 를 사용:

```powershell
npm run start:win
# 또는 직접:
.\scripts\start-windows.ps1
```

`start:win` 은 세션 encoding 을 UTF-8 로 강제한 뒤 `start:npm` 을 호출한다.

### `start:npm` 이 순차적으로 하는 일

1. **`prepare:plugins:npm`** — 플러그인 5개 각자 `npm run build`
2. **`build:npm`** — host TypeScript (tsc) + esbuild (renderer/preload) + Tailwind
3. **`node scripts/run-electron.mjs dist/src/main.js`** — Electron 실행

### `scripts/run-electron.mjs` 가 자동으로 주입하는 것들

| 항목 | 기본값 | 목적 |
|------|--------|------|
| `LVIS_DEV` | `1` | 플러그인 루트 경계 검사 완화 (dev 사이드-바이-사이드 링크 허용) |
| `LVIS_DEV_SKIP_SIG` | `1` | 로컬 빌드 플러그인 서명 검증 skip |
| `PYTHONIOENCODING` / `PYTHONUTF8` | `utf-8` / `1` | Python subprocess 출력 UTF-8 고정 |
| `LANG` / `LC_ALL` | `en_US.UTF-8` | locale UTF-8 |
| Electron flags (win32) | `--disable-gpu --use-angle=swiftshader --no-sandbox --in-process-gpu` 등 | GPU error_code=18 회피 |
| `chcp 65001` | auto | 콘솔 UTF-8 → 한글/이모지 로그 정상 표시 |

Electron 은 `cmd.exe /s /c "chcp 65001>nul & electron.exe …"` 형태로 래핑되어
실행되므로, chcp 와 Electron 이 같은 콘솔에서 돌면서 인코딩이 유지된다.

### 성공 신호

로그에:
```
[lvis] boot: ready (N tools, 5 plugins, 0 mcp)
```

창이 뜨고 좌측 사이드바 / 상단 탭에 플러그인 5개 (pageindex, meeting, email,
calendar, lge-api) 가 보이면 성공.

## 4. 환경변수 (선택 — opt-out/debug)

기본값은 전부 자동 세팅되지만 특수 환경에서 덮어쓰고 싶을 때:

| 변수 | 값 | 효과 |
|------|----|------|
| `LVIS_KEEP_GPU` | `1` | Windows safe-GPU flag 자동 주입 skip (GPU 정상 VM/CI 에서) |
| `LVIS_EXTRA_ELECTRON_FLAGS` | `"--foo --bar"` | 기본 safe-flag 를 유지한 채 추가 플래그 append |
| `LVIS_SKIP_CORP_CA` | `1` | 해외망/비-LG 네트워크 — 사내망 CA 추출 완전 skip |
| `LVIS_CORP_CA_DEBUG` | `1` | Windows/Linux CA 추출 Phase 3 pending 로그 표시 |
| `LVIS_DEV` | `0` | 플러그인 경로 경계 검사 엄격 모드 (production-like) |
| `LVIS_DEV_SKIP_SIG` | `0` | 플러그인 서명 검증 활성화 (managed 빌드 테스트용) |
| `LVIS_DEBUG` | `1` | `run-electron.mjs` 가 적용한 args/env 를 stderr 로 출력 |

일회성 사용:
```powershell
$env:LVIS_KEEP_GPU = "1"
npm run start:npm
```

PowerShell 세션 간 유지하려면 `$PROFILE` 에 추가.

## 5. 문제 해결

### `npm install` 에러: `errno -4068 symlink`
**원인**: `--install-links=true` 플래그 누락.
**해결**:
```powershell
npm install --legacy-peer-deps --install-links=true
```

### 재설치할 때 `Remove-Item -Recurse` 이상 동작
PowerShell 5.x 는 directory symlink 를 제대로 못 지움 — target 까지 따라가서
지우거나 link stub 을 남겨둠. cmd 의 `rmdir /s /q` 를 쓸 것:
```powershell
cmd /c "if exist node_modules rmdir /s /q node_modules"
cmd /c "if exist dist rmdir /s /q dist"
cmd /c "if exist packages\plugin-sdk\dist rmdir /s /q packages\plugin-sdk\dist"
cmd /c "if exist packages\plugin-sdk\node_modules rmdir /s /q packages\plugin-sdk\node_modules"
```

### 실행 시 `Cannot find module '@lvis/plugin-sdk/keys'` / `dist/keys.js` 없음
**원인**: `--install-links=true` 가 `packages/plugin-sdk` 를 빌드 전에 snapshot 복사 →
postinstall 이 빌드를 해도 `node_modules` copy 에는 반영 안됨.

최신 main 에는 이 순서 문제를 해결하는 sync 스텝이 `ensure-submodules.mjs` 에 들어있음
([`commit d956fb5`](https://github.com/lvis-project/lvis-app/commit/d956fb5)).
main 에서 설치했는데도 재현되면:

```powershell
git log -1 --format=%H scripts/ensure-submodules.mjs
# d956fb5 이후 커밋이어야 함
```

수동 workaround:
```powershell
cmd /c "if exist node_modules\@lvis\plugin-sdk\dist rmdir /s /q node_modules\@lvis\plugin-sdk\dist"
xcopy /E /I /Y packages\plugin-sdk\dist node_modules\@lvis\plugin-sdk\dist
dir node_modules\@lvis\plugin-sdk\dist\keys.js
npm run start:npm
```

### 실행 시 `electron.exe 는 실행할 수 있는 프로그램… 아닙니다`
**원인**: cmd.exe 의 legacy quote-stripping 규칙. 최신 main 에는 `shell: true`
로 `cmd.exe /d /s /c` 가 적용되어 해결됨
([`commit ee41513`](https://github.com/lvis-project/lvis-app/commit/ee41513)).
재현되면 브랜치 최신 여부 확인:
```powershell
git log -1 --format=%H scripts/run-electron.mjs
```

### Electron 창 크래시: "GPU process isn't usable. Goodbye!" / error_code=18
`run-electron.mjs` 가 Windows 에서 자동으로 software rendering flag
(`--disable-gpu`, `--disable-software-rasterizer`, `--disable-gpu-compositing`,
`--no-sandbox`) 를 주입한다. `LVIS_KEEP_GPU=1` 이 설정돼있으면 skip 되니 해제:
```powershell
Remove-Item Env:\LVIS_KEEP_GPU -ErrorAction SilentlyContinue
npm run start:npm
```

적용된 flag 를 직접 확인하려면:
```powershell
$env:LVIS_DEBUG = "1"
npm run start:npm
# [run-electron] args=["dist/src/main.js","--disable-gpu",...] 로그 확인
```

여전히 GPU 크래시 나면 추가 플래그를 `LVIS_EXTRA_ELECTRON_FLAGS` 로 주입:
```powershell
$env:LVIS_EXTRA_ELECTRON_FLAGS = "--disable-webgl --disable-d3d11"
npm run start:npm
```

### 한글 로그 깨짐
PowerShell 5.x 의 `[Console]::OutputEncoding` 이 세션 초기화 시점의 system ACP (cp949) 로
캐시돼서, 외부 프로세스 UTF-8 출력이 mangling 되는 경우가 드물게 있다.
현재 세션에서:
```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001
npm run start:npm
```

영구 설정 — `$PROFILE` 파일에 추가:
```powershell
if (!(Test-Path $PROFILE)) { New-Item -Type File -Force $PROFILE }
notepad $PROFILE
```
내용:
```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null
```

### `[lvis] corporate CA not found` 경고 (비-LG 네트워크)
정상 — macOS 키체인에 LGERootCA 가 없으면 나오는 informational log.
해외망/비사내망에서는 무시 가능. 확실히 끄고 싶으면:
```powershell
$env:LVIS_SKIP_CORP_CA = "1"
```

### 플러그인 레포 수정 후 반영 안 됨
`--install-links=true` 는 copy 모드라 sibling 플러그인 repo 수정 후 자동 반영 X.
플러그인 repo 수정 후:
```powershell
npm run prepare:plugins:npm    # sibling 플러그인 재빌드
npm run start:npm              # 재실행
```

그래도 반영 안 되면 완전 재설치:
```powershell
cmd /c "if exist node_modules rmdir /s /q node_modules"
npm install --legacy-peer-deps --install-links=true
```

## 6. 업데이트

```powershell
cd lvis-app
git pull --recurse-submodules

cd ..\lvis-plugin-pageindex  ; git pull
cd ..\lvis-plugin-meeting    ; git pull
cd ..\lvis-plugin-email      ; git pull
cd ..\lvis-plugin-calendar   ; git pull
cd ..\lvis-plugin-lge-api    ; git pull

cd ..\lvis-app
npm install --legacy-peer-deps --install-links=true
npm run start:npm
```

## 7. 검증 체크리스트

설치/실행 후 다음 항목 점검:

- [ ] `dir node_modules\@lvis\plugin-sdk\dist\keys.js` → 파일 존재
- [ ] 로그 한글 깨짐 없음
- [ ] `[lvis] boot: ready (N tools, 5 plugins, 0 mcp)` 로그 출력
- [ ] 창이 뜨고 좌측 사이드바에 플러그인 5개 (pageindex / meeting / email / calendar / lge-api) 노출
- [ ] 각 플러그인 탭 클릭 → UI 정상 렌더링
- [ ] `Ctrl+Shift+I` DevTools → Console 에 빨간 에러 없음
- [ ] GPU error_code=18 / ERR_ABORTED(-3) crash 없음

## 관련 커밋 / 문서

- PR [#192](https://github.com/lvis-project/lvis-app/pull/192) — 사내망 Windows first-run 패치
- PR [#182](https://github.com/lvis-project/lvis-app/pull/182) — 이전 Windows dev 지원
- 코드 진입점: [`scripts/run-electron.mjs`](../../scripts/run-electron.mjs),
  [`scripts/ensure-submodules.mjs`](../../scripts/ensure-submodules.mjs)
- 관련 환경변수 정의: [`src/main/corp-ca-loader.ts`](../../src/main/corp-ca-loader.ts)
