# lvis-app (test host)
`lvis` 메인 패키지가 아직 없는 상태에서 플러그인 통합을 검증하기 위한 테스트용 Electron 호스트입니다.

## 포함 내용
- Plugin Runtime + Manifest 기반 동적 로딩
- `~/.lvis/plugins/registry.json` 기반 manifestPath 동적 로딩
- `@lvis/plugin-local-indexer`, `@lvis/plugin-meeting`, `@lvis/plugin-ms-graph`,
  `@lvis/plugin-lge-api`, `@lvis/plugin-work-proactive`, `@lvis/plugin-agent-hub`
  마켓플레이스 install 또는 `lvis-cli install file://<path-to-dist.zip>` 으로 사이드로드
- 앱 시작 시 PageIndex 워커 + 자동 인덱서 구동
- 실제 채팅 UI(렌더러) + preload IPC 브리지
- IPC 핸들러
  - `lvis:index:scan`
  - `lvis:index:documents`
  - `lvis:chat:preview`
  - `lvis:meeting:start`
  - `lvis:meeting:push-chunk`
  - `lvis:meeting:stop`
  - `lvis:meeting:transcript`
- E2E 플로우 스모크 테스트 스크립트

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

## 선제성 엔진 (Proactive Engine)

`src/core/proactive-engine.ts`가 앱 부팅 시 초기화되어 사용자에게 선제적 정보를 제공합니다.

### 데일리 브리핑

앱 시작 시 `ProactiveEngine.collectBriefingItems()`가 실행되어 태스크, 이메일, **캘린더 일정**을 통합한 브리핑을 생성합니다.

- **진행 중 미팅** (high priority): 현재 시각 기준 시작~종료 사이인 일정
- **예정 미팅** (medium priority): 향후 2시간 이내 일정
- **종일 일정** (low priority): 당일 종일 이벤트

캘린더 데이터는 앱 부팅 시 기본적으로 `calendar_today`를 통해 당일 일정만 로드되어 캐시에 저장됩니다 (`calendarEventsCache`). 월요일에는 추가로 `calendar_list({ days: 7 })`를 호출해 주간 일정 캐시를 갱신합니다.  
`getBriefingPromptData()`는 이 캐시를 바탕으로 오늘 일정 요약 텍스트(최대 8건)를 LLM 프롬프트에 자동으로 포함합니다.

### 캘린더 플러그인 선제성 기능

| # | 기능 | 트리거 | 출력 이벤트 |
|---|------|--------|------------|
| 1 | **일정 생성 시 충돌 감지** | `calendar_create` 호출 | 응답에 `conflictWarning`, `alternativeSlots` 포함 |
| 2 | **이메일 → 미팅 요청 자동 감지** | `email.action.needed` 이벤트 | `calendar.from_email.suggested` |
| 3 | **월요일 주간 일정 요약** | 앱 부팅 (월요일) | ProactiveEngine 캐시 갱신 |
| 4 | **반복 패턴 감지** | `calendar_detect_patterns` 호출 | `calendar.pattern.detected` 이벤트, UI에 표시 |

### OS 알림 (manifest 선언형)

플러그인은 `plugin.json`의 `notificationEvents`에 OS 알림을 띄울 이벤트를 선언합니다. `boot.ts`는 플러그인을 알 필요 없이 manifest만 읽어 자동 등록합니다:

```json
{
  "notificationEvents": [
    { "event": "email.new", "titleField": "sender", "bodyField": "subject" }
  ]
}
```

### 이벤트 버스

선제성 기능은 `emitEvent` / `onEvent` 기반 비동기 이벤트 버스로 통신합니다:

| 이벤트 | 발행자 | 구독자 |
|--------|--------|--------|
| `calendar.from_email.suggested` | calendar hostPlugin | — |
| `calendar.pattern.detected` | calendar hostPlugin | calendar UI |
| `email.action.needed` | email hostPlugin | calendar hostPlugin |
| `email.new` | email hostPlugin | boot.ts (OS 알림) |
| `meeting.ended` | meeting hostPlugin | calendar hostPlugin |

## 설치

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
> (`node scripts/fetch-uv.mjs`)와 Electron 실행 스크립트
> (`scripts/run-electron.mjs`)는 시스템 `node` CLI를 직접 호출합니다.
> Electron 내장 Node는 PATH의 `node` 바이너리를 대체하지 않으므로,
> **개발자 머신에 Node.js v18 이상**이 별도로 설치되어 있어야 합니다.

## Windows (사내망) 실행 가이드

Windows corp PC(사내망, Hyper-V/VDI, EDR/AV 샌드박스 환경)에서의 first-run 경험을 단순화하기 위해 `scripts/run-electron.mjs` 가 다음을 자동 처리합니다.

- **GPU 문제 우회** — Electron GPU 프로세스가 `error_code=18` 또는 "GPU process isn't usable. Goodbye!" 로 크래시하는 것을 막기 위해 `--disable-gpu`, `--disable-software-rasterizer`, `--disable-gpu-compositing`, `--no-sandbox` 플래그를 자동 추가합니다. GPU 정상 환경(패스스루 VM / CI)에서는 `LVIS_KEEP_GPU=1` 로 opt-out 하고, 추가 플래그가 필요하면 `LVIS_EXTRA_ELECTRON_FLAGS="--foo --bar"` 로 append 가능.
- **플러그인 경로 허용** — dev runner는 `LVIS_DEV=1` 을 세팅해 로컬 개발 entry 경로를 허용합니다. 마켓플레이스 artifact 검증과 install receipt 무결성 검사는 dev env flag로 우회하지 않습니다.
- **콘솔 UTF-8 정렬** — Windows 콘솔을 `chcp 65001` 로 UTF-8 로 전환하고 `PYTHONIOENCODING=utf-8`, `PYTHONUTF8=1`, `LANG/LC_ALL=en_US.UTF-8` 환경변수를 기본 주입합니다. cp949 로 인한 한글/이모지 깨짐이 사라집니다.

### 권장 설치 절차 (사내망)

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

### 사내망 환경변수 요약

| 변수 | 기본값 | 목적 |
|------|--------|------|
| `LVIS_DEV` | `1` (unpackaged) | 플러그인 루트 경계 검사 완화 (`../../../node_modules/@lvis/*` 허용) |
| `LVIS_KEEP_GPU` | 미설정 | `1` 이면 Windows GPU safe-flag 주입 skip |
| `LVIS_EXTRA_ELECTRON_FLAGS` | 미설정 | 기본 flag 유지한 채 추가 Electron flag append (`"--foo --bar"`) |
| `LVIS_DEBUG` | 미설정 | `1` 이면 `run-electron.mjs` 가 적용한 args/env 출력 |
| `LVIS_SKIP_CORP_CA` | 미설정 | `1` 이면 macOS 키체인 CA 추출도 skip (해외망/비-LG 네트워크) |
| `LVIS_CORP_CA_DEBUG` | 미설정 | `1` 이면 Windows/Linux CA 추출 Phase 3 pending 로그 표시 |
| `PYTHONIOENCODING` | `utf-8` | Python subprocess 출력 UTF-8 고정 |

## 테스트
```bash
bun run test:electron-smoke
bun run test:main-flow
bunx vitest run
```

## 실행
```bash
# 실제 PageIndex 모드 (설치/키 필요)
# LOCAL_INDEXER_ROOT=/absolute/path/to/local-indexer OPENAI_API_KEY=... bun run start
bun run start
```
