# lvis-app

LVIS 데스크톱 호스트 앱입니다. Electron main/renderer/preload, 플러그인 런타임, 채팅 UI, 마켓플레이스 설치 흐름, Python 런타임 부트스트랩, OS별 installer 패키징을 이 저장소에서 관리합니다.

## 포함 내용
- Plugin Runtime + Manifest 기반 동적 로딩
- `~/.lvis/plugins/registry.json` 기반 manifestPath 동적 로딩
- `@lvis/plugin-local-indexer`, `@lvis/plugin-meeting`, `@lvis/plugin-ms-graph`,
  `@lvis/plugin-work-assistant`, `@lvis/plugin-agent-hub`
  마켓플레이스 install 또는 `lvis-cli install file://<path-to-dist.zip>` 으로 사이드로드
- 부팅 시 managed marketplace plugin 자동 install/refresh (`src/boot/managed-marketplace.ts` → `ensureManagedInstalled()` → `pluginRuntime.restartAll()`) 및 first-boot 진행 상태를 `lvis:bootstrap:status` IPC 로 renderer 에 emit
- Host-side **HybridRetriever** (`src/main/hybrid-retriever.ts`) — Local Indexer plugin worker 의 BM25 + Vector 검색 결과와 Cloud adapter 를 RRF (k=60) 로 융합. 문서 인덱싱/워커 수명주기는 `@lvis/plugin-local-indexer` 가 담당
- 실제 채팅 UI(렌더러) + preload IPC 브리지
- webpack 기반 renderer/preload/plugin-preload 번들링
- macOS Apple Silicon / Linux / Windows installer 빌드 스크립트와 GitHub Actions matrix
- 주요 IPC 핸들러 (전체 목록은 `src/ipc/domains/*.ts` 참조)
  - 채팅 / 세션: `lvis:chat:send`, `lvis:chat:abort`, `lvis:chat:sessions`, `lvis:chat:session-resume`, `lvis:chat:fork`, `lvis:chat:branch-from-checkpoint`, `lvis:chat:edit-resend`, `lvis:chat:export`, `lvis:chat:compact`
  - 워크플로우: `lvis:ask-user-question:respond` (인라인 질문 카드 응답)
  - 미팅: `lvis:meeting:start`, `lvis:meeting:push-chunk`, `lvis:meeting:stop`, `lvis:meeting:transcript`
  - 거버넌스: `lvis:audit:search`, `lvis:dlp:stats`, `lvis:agents:list`, `lvis:agents:install`
- E2E 플로우 스모크 테스트 스크립트

## 현재 빌드/배포 상태

- 개발 실행: `bun run start` (build → Electron launch). 인크리멘털 dev 루프는 `bun run dev`
- 타입 검사: `bun run typecheck`
- 앱 빌드: `bun run build`
- 현재 OS installer: `bun run dist`
- OS별 installer:
  - macOS Apple Silicon: `bun run dist:mac` → DMG + ZIP
  - Linux: `bun run dist:linux` → AppImage + DEB + RPM
  - Windows: `bun run dist:win` → NSIS setup + ZIP
- 3개 OS 전체 산출물은 GitHub Actions **Build Installers** workflow에서 생성합니다.
- production release 세부 절차는 [`docs/references/production-release-checklist.md`](./docs/references/production-release-checklist.md)를 기준으로 합니다.

## 동적 플러그인 매니페스트
설치된 플러그인은 `~/.lvis/plugins/<id>/plugin.json` 에 위치하며 `~/.lvis/plugins/registry.json` 가 활성 목록을 관리합니다. `<repo>/plugins/installed/...` 의 in-tree 레이아웃은 Phase 2 부터 폐기되었습니다.

## Plugins Registry CLI
```bash
bun run plugins:list
bun run plugins:add -- <plugin-id> <manifest-path>
bun run plugins:remove -- <plugin-id>
bun run plugins:enable -- <plugin-id>
bun run plugins:disable -- <plugin-id>
```

설치는 더 이상 이 CLI 가 다루지 않습니다. 마켓플레이스 카드 / `lvis://install/<slug>` 딥링크 / `lvis-cli install file://<path-to-dist.zip>` (사이드 레포 dev) 가 현재 install 진입점입니다.

예시:
```bash
bun run plugins:add -- search search/plugin.json
```

Electron 앱 좌측 사이드바의 **플러그인 마켓플레이스** 영역에서 설치 버튼을 눌러도 동일하게 로컬 설치/등록이 수행됩니다.  
설치된 플러그인이 `plugin.json`의 `ui` 확장을 제공하면, 메인 패널 상단 탭(및 앱 메뉴바)에서 선택해 해당 플러그인 UI를 열 수 있습니다.
탭/메뉴 라벨은 `ui.displayName`을 우선 사용하고, 없으면 `title`을 사용합니다.
`kind: "embedded-module"` 확장은 플러그인 패키지 내부 UI 모듈(예: `dist/ui/meeting-control.js`)을 호스트가 동적 import하여 인라인으로 마운트합니다.
UI 렌더링 책임은 호스트(`lvis-app` renderer)에 있으며, 플러그인은 `plugin.json`의 `ui` 메타데이터와 실제 UI 모듈 자산, 그리고 기능 메서드를 제공합니다.

### Managed plugin install / refresh

- `ensureManagedInstalled()` 는 앱 부팅 시 marketplace 카탈로그의 managed 플러그인을 확인하고, registry 에 stale entry 만 남아 있는 경우에도 실제 manifest 존재 여부를 다시 검사해 재설치합니다.
- `lvis://install/{slug}` 딥링크 설치가 완료되면 renderer 는 install-result 이벤트를 받아 플러그인 뷰/마켓플레이스 목록을 자동 refresh 합니다.

### Plugin config safety

- Settings > 플러그인 설정 저장 경로는 sender-guarded IPC 를 통해서만 접근됩니다.
- 플러그인 설정값은 plain JSON-compatible object/array/primitive 만 허용하며, `__proto__`, `constructor`, `prototype`, `"*"` 같은 위험 키는 저장 시 차단됩니다.

## 독립 플러그인 아키텍처
- 메인 앱은 플러그인 구현을 직접 import하지 않고 `PluginRuntime`이 매니페스트를 읽어 런타임 동적 로드합니다.
- 각 플러그인은 자체 host entry(`host-plugin`)를 제공하고, 메서드 단위(`index_scan`, `meeting_start` 등)로 기능을 노출합니다.
- 메인 프로세스는 IPC를 플러그인 메서드 호출로 브리지하며, 플러그인 추가/교체 시 매니페스트 변경만으로 확장 가능합니다.
- 라이프사이클(`start`/`stop`)은 runtime이 일괄 관리합니다.

## Overlay Trigger Surface

플러그인은 `host:overlay` capability 가 있을 때만 `hostApi.triggerConversation()`으로 host overlay 제안을 staged 할 수 있습니다. 이 호출은 대화를 직접 시작하지 않으며, 사용자가 overlay CTA 를 수락한 뒤에만 main chat 의 일반 `ConversationLoop`와 권한 경로로 들어갑니다.

- `source`는 `overlay:<reason>` 형식만 허용됩니다.
- plugin-authored prompt 는 slash command 로 dispatch 되지 않도록 host에서 선행 `/`를 제거합니다.
- write/shell/network 도구는 overlay-trigger origin일 때 항상 사용자 확인을 다시 거칩니다.

### OS 알림 (manifest 선언형)

플러그인은 `plugin.json`의 `notificationEvents`에 OS 알림을 띄울 이벤트를 선언합니다. `boot.ts`는 플러그인을 알 필요 없이 manifest만 읽어 자동 등록합니다:

```json
{
  "notificationEvents": [
    { "event": "meeting.summary.created", "titleField": "title", "bodyField": "summary" }
  ]
}
```

### 이벤트 버스

선제성 기능은 `emitEvent` / `onEvent` 기반 비동기 이벤트 버스로 통신합니다. 현재 활성 플러그인 셋(`meeting`, `work-assistant`, `local-indexer`, `ms-graph`, `agent-hub`) 기준:

| 이벤트 | 발행자 | 구독자 |
|--------|--------|--------|
| `meeting.summary.created` | meeting hostPlugin | work-assistant, boot.ts (OS 알림) |
| `meeting.transcript.updated` | meeting hostPlugin | boot.ts (OS 알림) |
| `meeting.summary.degraded` | meeting hostPlugin | boot.ts (OS 알림) |
| `meeting.ended` | meeting hostPlugin | work-assistant |

플러그인은 manifest 의 `emittedEvents` / `subscriptions` 로 이벤트 계약을 선언하고, manifest validator 가 `auth` capability 와 `${id}.auth.changed` 같은 cross-field 일관성을 boot 시 검사합니다.

## 채팅 UX 핵심

### `ask_user_question` 카드
LLM 이 분기점에서 사용자에게 직접 묻는 인라인 워크플로우 도구. 한 카드에 **1~4개**의 관련 질문을 묶어 호출하며, 페이지네이션으로 차례로 답하고 마지막 컨펌 페이지에서 한꺼번에 제출합니다.

- **`choices` / `recommendedIndex` / `altIndices`**: 객관식 chip 0~3개. UI 가 칩 앞쪽에 "추천" / "대안" 배지를 자동 부착합니다 (모델은 평문 라벨만 emit).
- **`allowFreeText`** (기본 true): 단일-라인 자유 입력. chip 만으로 안 풀리는 경우의 escape hatch.
- **`allowMultiple`** (기본 false): 다중 선택 모드. true 일 때 응답이 `answers[i].choices: string[]` 으로 돌아오고 자동 제출이 비활성화되어 사용자가 명시적으로 "보내기"를 눌러야 합니다.
- **키보드 네비게이션**: 카드 mount 시 자동 포커스 → `↑/↓` 답변/자유입력 이동, `←/→` 질문 이동, `Enter` 다음/검토/보내기, `Esc` 건너뛰기.
- **타임아웃**: 5분 안에 확인이 없으면 `dismissed: true` 로 반환, LLM 은 기본값으로 폴백.

### Suggested Replies
대화 흐름에서 다음 사용자 입력을 보조하는 chip row + ghost suggestion. 입력창에 텍스트를 치기 시작하면 자동 hide, IME composition 중에도 ghost 가 표시되지 않습니다.

### Status Bar
상태 표시줄은 텍스트 라벨 대신 플랫폼-emoji 글리프로 렌더링하고, 스크린 리더용 a11y 라벨은 별도로 유지합니다.

## 개발 환경 설치

이 저장소는 `packages/plugin-sdk`를 git submodule (`lvis-plugin-sdk`)로 참조합니다.
clone 시 submodule 을 함께 가져오는 것을 권장합니다:

```bash
git clone <repo-url>
```

```bash
bun install
```

이 저장소는 **bun**을 기본 패키지 매니저 + 스크립트 러너로 사용합니다.
Electron 런타임 자체는 여전히 Node로 구동됩니다 (`scripts/run-electron.mjs`
가 `electron` 바이너리를 실행하며, bun으로 Electron 프로세스를 띄우지는
않습니다).

> **⚠️ Node.js 필수:** bun이 기본 러너이지만, `postinstall` 스크립트
> (`node scripts/fetch-uv.mjs`, `node scripts/register-lvis-protocol.mjs`) 와
> Electron 실행 스크립트 (`scripts/run-electron.mjs`)는 시스템 `node` CLI를
> 직접 호출합니다. Electron 내장 Node는 PATH의 `node` 바이너리를 대체하지
> 않으므로, **개발자 머신에 Node.js v22.4 이상** (`package.json` `engines.node`
> 기준) 이 별도로 설치되어 있어야 합니다.

## 빌드

```bash
# 타입 검사 (별도 단계 — build 에는 포함되지 않음)
bun run typecheck

# main esbuild bundle + webpack renderer/preload + Tailwind CSS + asset copy + TLS guard
bun run build

# Electron version smoke test
bun run test:electron-smoke
```

`bun run build`는 다음 단계를 수행합니다.

1. `scripts/clean-dist.mjs` 로 `dist/` 를 비웁니다.
2. `scripts/generate-lvis-icons.cjs` 로 앱 아이콘 자산을 생성합니다.
3. `scripts/build-main-esbuild.mjs` (esbuild) 로 main/shared TypeScript를 번들합니다.
4. `webpack.config.cjs`의 `renderer`, `preload`, `pluginPreload` compiler를 실행합니다.
5. Tailwind CSS를 `dist/src/styles.css`로 minify 출력합니다.
6. HTML/plugin shell/electron flag 자산을 `dist/`로 복사합니다.
7. TLS bypass guard (`check-no-tls-bypass.mjs`) 를 실행합니다.

> 타입 검사는 `bun run build` 에 포함되지 않습니다. 별도 `bun run typecheck` (`tsc --noEmit`) 로 검사합니다.

## 설치 파일 생성

installer 스크립트는 `scripts/build-installers.mjs`가 단일 진입점입니다. native dependency rebuild, OS별 signing/notarization 도구, installer format 차이를 줄이기 위해 각 OS installer는 해당 OS runner에서 생성하는 것을 원칙으로 합니다.

```bash
# 현재 OS installer
bun run dist

# OS별 native installer
bun run dist:mac
bun run dist:linux
bun run dist:win
```

출력은 `release/` 아래에 생성됩니다.

| OS | 산출물 |
|----|--------|
| macOS Apple Silicon | `LVIS-<version>-mac-arm64.dmg`, `LVIS-<version>-mac-arm64.zip` |
| Linux | `LVIS-<version>-linux-<arch>.AppImage`, `.deb`, `.rpm` |
| Windows | `LVIS-<version>-windows-<arch>-setup.exe`, `LVIS-<version>-windows-<arch>.zip` |

unsigned 내부 검증 빌드는 직접 스크립트를 호출해 명시적으로 선택합니다.

```bash
node scripts/build-installers.mjs --current --skip-code-sign
```

전체 macOS/Linux/Windows artifact는 GitHub Actions의 **Build Installers** workflow에서 생성합니다. `skip_code_sign=true`는 내부 검증용 unsigned artifact를 만들고, production 배포 시에는 signing/notarization secrets를 설정한 뒤 `skip_code_sign=false`로 실행합니다.

macOS installer와 macOS 개발 환경은 Apple Silicon만 지원합니다. Intel Mac(`darwin/x64`)은 지원 대상에서 제외되어 `uv` bootstrap과 installer build가 fail-fast 합니다.

`lvis://` deep link protocol과 Python bootstrap용 `uv` binary가 packaged app resource로 포함됩니다. 개발 환경의 `postinstall`은 현재 지원 플랫폼의 `resources/uv/<platform>-<arch>/uv`만 준비하고, installer 빌드는 패키징 직전에 해당 target binary만 `resources/uv-runtime/`에 staging한 뒤 포함합니다.

## Windows 실행 가이드

Windows에서의 first-run 경험을 단순화하기 위해 `scripts/run-electron.mjs` 가 다음을 자동 처리합니다.

- **GPU 문제 우회** — Electron GPU 프로세스가 `error_code=18` 또는 "GPU process isn't usable. Goodbye!" 로 크래시하는 것을 막기 위해 `--disable-gpu`, `--disable-software-rasterizer`, `--disable-gpu-compositing`, `--no-sandbox` 플래그를 자동 추가합니다. GPU 정상 환경(VM 패스스루 / CI)에서는 `LVIS_KEEP_GPU=1` 로 opt-out 하고, 추가 플래그가 필요하면 `LVIS_EXTRA_ELECTRON_FLAGS="--foo --bar"` 로 append 가능.
- **플러그인 경로 허용** — dev runner는 `LVIS_DEV=1` 을 세팅해 로컬 개발 entry 경로를 허용합니다. 마켓플레이스 artifact 검증과 install receipt 무결성 검사는 dev env flag로 우회하지 않습니다.
- **콘솔 UTF-8 정렬** — Windows 콘솔을 `chcp 65001` 로 UTF-8 로 전환하고 `PYTHONIOENCODING=utf-8`, `PYTHONUTF8=1`, `LANG/LC_ALL=en_US.UTF-8` 환경변수를 기본 주입합니다. cp949 로 인한 한글/이모지 깨짐이 사라집니다.

> **Node.js 필수:** `scripts/run-electron.mjs` 는 시스템 `node` CLI를 직접 호출합니다. Node.js v22.4 이상이 설치되어 있어야 합니다.

### 권장 설치 절차

```bash
# 1) clone
git clone <repo-url>
cd lvis-app

# 2) deps 설치
bun install

# 3) 빌드 + 실행
bun run start
```

PowerShell 에서 한글이 깨지면 세션을 UTF-8 로 전환 후 동일 명령:

```powershell
chcp 65001
bun run start
```

> **PowerShell 5.x (Windows 기본) 주의**: `chcp` 만으로는 `[Console]::OutputEncoding`
> 캐시가 갱신되지 않아 mojibake 가 남는 경우가 있다.
> [`windows-setup.md` §5 "한글 로그 깨짐"](./docs/guides/windows-setup.md#5-문제-해결)
> 의 `[Console]::OutputEncoding` 명령을 함께 실행하거나 PowerShell 7+ / Windows
> Terminal 사용을 권장.

전체 Windows 설치/실행 가이드는 [`docs/guides/windows-setup.md`](./docs/guides/windows-setup.md) 참고.

### 환경변수 요약

| 변수 | 기본값 | 목적 |
|------|--------|------|
| `LVIS_DEV` | `1` (unpackaged) | 플러그인 루트 경계 검사 완화 (`../../../node_modules/@lvis/*` 허용) |
| `LVIS_KEEP_GPU` | 미설정 | `1` 이면 Windows GPU safe-flag 주입 skip |
| `LVIS_EXTRA_ELECTRON_FLAGS` | 미설정 | 기본 flag 유지한 채 추가 Electron flag append (`"--foo --bar"`) |
| `LVIS_DEV_CONSOLE` | `0` | `1` 이면 Electron DevTools 콘솔 창 자동 오픈 |
| `LVIS_DEBUG` | 미설정 | `1` 이면 `run-electron.mjs` 가 적용한 args/env 출력 |
| `LVIS_SKIP_CORP_CA` | 미설정 | `1` 이면 CA 자동 주입 skip |
| `LVIS_CORP_CA_DEBUG` | 미설정 | `1` 이면 CA 추출 디버그 로그 표시 |
| `PYTHONIOENCODING` | `utf-8` | Python subprocess 출력 UTF-8 고정 |

## 테스트
```bash
bun run typecheck
bun run build
bun run test
bun run test:electron-smoke
bun run test:main-flow
```

## 실행
```bash
# 기본 실행
bun run start

# Local Indexer 기능까지 사용/검증하려면:
#   1) marketplace/sideload 로 plugin을 먼저 설치
#   2) OPENAI_API_KEY 설정 후 실행
OPENAI_API_KEY=... bun run start
```

> `scripts/e2e-phase1.ts` 는 retired 상태입니다. 현재 host-side 검증의 source of truth 는
> `bun run test:main-flow`, `bun run test:electron-smoke`, `bun run build` 입니다.
> `docs/blueprints/*` 의 해당 스크립트 언급은 과거 Phase 1 기록입니다.
