# LVIS — Windows (사내망) 설치 & 실행 가이드

사내망 Windows PC 에서 LVIS 를 처음부터 실행까지 끝내는 원스톱 가이드.
`bun run start` 한 방으로 뜨도록 host 가 GPU flag / UTF-8 / 환경변수를
자동 주입하므로, 이 문서의 절차만 따르면 추가 세팅이 필요 없다.

## 0. 사전 요구사항

| 항목 | 최소 버전 | 확인 |
|------|----------|------|
| Node.js | 18+ (20 LTS 권장) | `node -v` |
| Bun | 1.2+ | `bun -v` |
| Git | 2.30+ | `git --version` |

터미널은 **PowerShell**, **Windows Terminal**, **cmd** 모두 OK.
Bun 은 macOS/Windows/Linux 동일하게 동작 — Windows 별 우회 스크립트 없음.

## 1. 저장소 clone (6개 레포)

LVIS 는 host 1개 + 플러그인 5개가 **같은 부모 디렉터리에 나란히** 있어야 한다
(`file:../lvis-plugin-*` 참조 때문).

```powershell
mkdir lvis-project
cd lvis-project

git clone --recurse-submodules https://github.com/lvis-project/lvis-app.git
git clone https://github.com/lvis-project/lvis-plugin-pageindex.git
git clone https://github.com/lvis-project/lvis-plugin-meeting.git
git clone https://github.com/lvis-project/lvis-plugin-ms-graph.git
git clone https://github.com/lvis-project/lvis-plugin-lge-api.git
git clone https://github.com/lvis-project/lvis-plugin-work-proactive.git
git clone https://github.com/lvis-project/lvis-plugin-agent-hub.git
```

완성된 구조:

```
lvis-project/
├── lvis-app/                  ← host (여기서 빌드·실행)
├── lvis-plugin-pageindex/
├── lvis-plugin-meeting/
├── lvis-plugin-ms-graph/
├── lvis-plugin-lge-api/
├── lvis-plugin-work-proactive/
└── lvis-plugin-agent-hub/
```

> `lvis-app` 은 `--recurse-submodules` 플래그 필수.
> `packages/plugin-sdk` 가 submodule 이기 때문.

## 2. 설치

```powershell
cd lvis-app
bun install
```

`packages/plugin-sdk` 는 source/type-only 패키지라 별도 빌드 불필요. `bun install`
이 sibling plugin repos 의 `file:../lvis-plugin-*` 경로를 자동으로 처리한다.

> **CI 와의 차이**: CI 는 `bun install --frozen-lockfile` 로 잠금 상태 그대로 재현한다.
> 로컬에서 잘 빌드되는데 CI 가 "lockfile mismatch" 로 실패하면 `bun install --frozen-lockfile`
> 로 동일 조건 재현 후 `bun.lock` 변경분을 commit.

## 3. 실행

```powershell
bun run start
```

PowerShell 에서 `[Console]::OutputEncoding` 캐시 문제로 한글이 깨지면 콘솔 인코딩만
UTF-8 로 전환:

```powershell
chcp 65001
bun run start
```

> **PowerShell 5.x 사용자 주의**: Windows 10/11 의 기본 PowerShell (5.1) 은 `chcp 65001`
> 이후에도 `[Console]::OutputEncoding` 이 세션 시작 시점의 cp949 로 캐시되어 있어 mojibake
> 가 그대로 나오는 경우가 있다. 이 때는 5절 "한글 로그 깨짐" 의 `[Console]::OutputEncoding`
> 명령을 함께 실행 (또는 PowerShell 7+ / Windows Terminal 사용).

영구 설정은 `$PROFILE` 에 추가 (5절 "한글 로그 깨짐" 참고).

### `bun run start` 가 순차적으로 하는 일

1. **`bun run prepare:plugins`** — 플러그인 6개 각자 `bun run build`
2. **`bun run build`** — host TypeScript (tsc) + esbuild (renderer/preload) + Tailwind
3. **`node scripts/run-electron.mjs dist/src/main.js`** — Electron 실행

### `scripts/run-electron.mjs` 가 자동으로 주입하는 것들

| 항목 | 기본값 | 목적 |
|------|--------|------|
| `LVIS_DEV` | `1` | 플러그인 루트 경계 검사 완화 (dev 사이드-바이-사이드 링크 허용) |
| `PYTHONIOENCODING` / `PYTHONUTF8` | `utf-8` / `1` | Python subprocess 출력 UTF-8 고정 |
| `LANG` / `LC_ALL` | `en_US.UTF-8` | locale UTF-8 |
| Electron flags (win32) | `--disable-gpu --use-angle=swiftshader --no-sandbox --in-process-gpu` 등 | GPU error_code=18 회피 |
| `chcp 65001` | auto | 콘솔 UTF-8 → 한글/이모지 로그 정상 표시 |

Electron 은 `cmd.exe /s /c "chcp 65001>nul & electron.exe …"` 형태로 래핑되어
실행되므로, chcp 와 Electron 이 같은 콘솔에서 돌면서 인코딩이 유지된다.

### 성공 신호

로그에:
```
[lvis] boot: ready (N tools, 6 plugins, 0 mcp)
```

창이 뜨고 좌측 사이드바 / 상단 탭에 플러그인이 보이면 성공.

## 4. 환경변수 (선택 — opt-out/debug)

기본값은 전부 자동 세팅되지만 특수 환경에서 덮어쓰고 싶을 때:

| 변수 | 값 | 효과 |
|------|----|------|
| `LVIS_KEEP_GPU` | `1` | Windows safe-GPU flag 자동 주입 skip (GPU 정상 VM/CI 에서) |
| `LVIS_EXTRA_ELECTRON_FLAGS` | `"--foo --bar"` | 기본 safe-flag 를 유지한 채 추가 플래그 append |
| `LVIS_SKIP_CORP_CA` | `1` | 해외망/비-LG 네트워크 — 사내망 CA 추출 완전 skip |
| `LVIS_CORP_CA_DEBUG` | `1` | Windows/Linux CA 추출 Phase 3 pending 로그 표시 |
| `LVIS_DEV` | `0` | 플러그인 경로 경계 검사 엄격 모드 (production-like) |
| `LVIS_DEBUG` | `1` | `run-electron.mjs` 가 적용한 args/env 를 stderr 로 출력 |

일회성 사용:
```powershell
$env:LVIS_KEEP_GPU = "1"
bun run start
```

PowerShell 세션 간 유지하려면 `$PROFILE` 에 추가.

## 5. 문제 해결

### 재설치할 때 `Remove-Item -Recurse` 이상 동작
PowerShell 5.x 는 directory 삭제 시 일부 잠금/권한 문제로 stub 을 남기는 경우가
있다. cmd 의 `rmdir /s /q` 사용:
```powershell
cmd /c "if exist node_modules rmdir /s /q node_modules"
cmd /c "if exist dist rmdir /s /q dist"
```

### 실행 시 `Cannot find module '@lvis/plugin-sdk'`
**원인**: `node_modules` 가 오래되어 source/type-only SDK 링크가 갱신되지 않음.
**해결**: `node_modules` 를 삭제한 뒤 다시 설치합니다.

```powershell
cmd /c "if exist node_modules rmdir /s /q node_modules"
bun install
bun run start
```

### Electron 창 크래시: "GPU process isn't usable. Goodbye!" / error_code=18
`run-electron.mjs` 가 Windows 에서 자동으로 software rendering flag
(`--disable-gpu`, `--disable-software-rasterizer`, `--disable-gpu-compositing`,
`--no-sandbox`) 를 주입한다. `LVIS_KEEP_GPU=1` 이 설정돼있으면 skip 되니 해제:
```powershell
Remove-Item Env:\LVIS_KEEP_GPU -ErrorAction SilentlyContinue
bun run start
```

적용된 flag 를 직접 확인하려면:
```powershell
$env:LVIS_DEBUG = "1"
bun run start
# [run-electron] args=["dist/src/main.js","--disable-gpu",...] 로그 확인
```

여전히 GPU 크래시 나면 추가 플래그를 `LVIS_EXTRA_ELECTRON_FLAGS` 로 주입:
```powershell
$env:LVIS_EXTRA_ELECTRON_FLAGS = "--disable-webgl --disable-d3d11"
bun run start
```

### 한글 로그 깨짐
PowerShell 5.x 의 `[Console]::OutputEncoding` 이 세션 초기화 시점의 system ACP
(cp949) 로 캐시돼서, 외부 프로세스 UTF-8 출력이 mangling 되는 경우가 드물게 있다.
현재 세션에서:
```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001
bun run start
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

또는 Windows Terminal (UTF-8 default) 사용으로 회피.

### `[lvis] corporate CA not found` 경고 (비-LG 네트워크)
정상 — macOS 키체인에 LGERootCA 가 없으면 나오는 informational log.
해외망/비사내망에서는 무시 가능. 확실히 끄고 싶으면:
```powershell
$env:LVIS_SKIP_CORP_CA = "1"
```

### 플러그인 레포 수정 후 반영 안 됨
플러그인 repo 의 dist 가 source dir 의 `dist/` symlink 형태로 ~/.lvis 와
연결되므로 source 의 `bun run build` 만 다시 실행하면 즉시 반영.
plugin.json (manifest) 변경은 host 재시작 후 적용:
```powershell
cd ..\lvis-plugin-meeting
bun run build
cd ..\lvis-app
bun run start
```

## 6. 업데이트

```powershell
cd lvis-app
git pull --recurse-submodules

cd ..\lvis-plugin-pageindex      ; git pull
cd ..\lvis-plugin-meeting        ; git pull
cd ..\lvis-plugin-ms-graph       ; git pull
cd ..\lvis-plugin-lge-api        ; git pull
cd ..\lvis-plugin-work-proactive ; git pull
cd ..\lvis-plugin-agent-hub      ; git pull

cd ..\lvis-app
bun install
bun run start
```

## 7. 검증 체크리스트

설치/실행 후 다음 항목 점검:

- [ ] 로그 한글 깨짐 없음
- [ ] `[lvis] boot: ready (N tools, 6 plugins, 0 mcp)` 로그 출력
- [ ] 창이 뜨고 좌측 사이드바에 플러그인이 노출
- [ ] 각 플러그인 탭 클릭 → UI 정상 렌더링
- [ ] `Ctrl+Shift+I` DevTools → Console 에 빨간 에러 없음
- [ ] GPU error_code=18 / ERR_ABORTED(-3) crash 없음

## 관련 커밋 / 문서

- 코드 진입점: [`scripts/run-electron.mjs`](../../scripts/run-electron.mjs)
- 관련 환경변수 정의: [`src/main/corp-ca-loader.ts`](../../src/main/corp-ca-loader.ts)
