# lvis-app (test host)
`lvis` 메인 패키지가 아직 없는 상태에서 플러그인 통합을 검증하기 위한 테스트용 Electron 호스트입니다.

## 포함 내용
- Plugin Runtime + Manifest 기반 동적 로딩
- `plugins/registry.json` 기반 manifestPath 동적 로딩
- `@lvis/plugin-pageindex`, `@lvis/plugin-meeting`, `@lvis/plugin-email`, `@lvis/plugin-calendar` 동적 통합
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
- `plugins/installed/pageindex/plugin.json`
- `plugins/installed/meeting/plugin.json`
- `plugins/installed/email/plugin.json`
- `plugins/installed/calendar/plugin.json`
- `plugins/registry.json` (활성 플러그인 목록)

## Plugins Registry CLI
```bash
bun run plugins:list
bun run plugins:install -- <plugin-id>
bun run plugins:add -- <plugin-id> <manifest-path>
bun run plugins:remove -- <plugin-id>
bun run plugins:enable -- <plugin-id>
bun run plugins:disable -- <plugin-id>
```

예시:
```bash
bun run plugins:install -- meeting
bun run plugins:add -- search search/plugin.json
```

Electron 앱 좌측 사이드바의 **플러그인 마켓플레이스** 영역에서 설치 버튼을 눌러도 동일하게 로컬 설치/등록이 수행됩니다.  
설치된 플러그인이 `plugin.json`의 `ui` 확장을 제공하면, 메인 패널 상단 탭(및 앱 메뉴바)에서 선택해 해당 플러그인 UI를 열 수 있습니다.
탭/메뉴 라벨은 `ui.displayName`을 우선 사용하고, 없으면 `title`을 사용합니다.
`kind: "embedded-module"` 확장은 플러그인 패키지 내부 UI 모듈(예: `dist/ui/meeting-control.js`)을 호스트가 동적 import하여 인라인으로 마운트합니다.
UI 렌더링 책임은 호스트(`lvis-app` renderer)에 있으며, 플러그인은 `plugin.json`의 `ui` 메타데이터와 실제 UI 모듈 자산, 그리고 기능 메서드를 제공합니다.

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
git clone --recurse-submodules <repo-url>
# 이미 recurse 없이 clone 한 경우:
git submodule update --init --recursive
```

`bun install` 은 `postinstall` 단계에서 `scripts/ensure-submodules.mjs` 가드를
실행하여 submodule 디렉터리가 비어 있으면 자동으로 `git submodule update --init
--recursive` 를 호출합니다. 따라서 fresh clone 직후 `bun install` 이
`@lvis/plugin-sdk/keys` 미존재로 실패하지 않습니다.

```bash
bun install
```

이 저장소는 **bun**을 기본 패키지 매니저 + 스크립트 러너로 사용합니다.
Electron 런타임 자체는 여전히 Node로 구동됩니다 (`scripts/run-electron.mjs`
가 `electron` 바이너리를 실행하며, bun으로 Electron 프로세스를 띄우지는
않습니다). 문제가 발생하면 `*:npm` 폴백 스크립트(`start:npm`, `build:npm`,
`prepare:plugins:npm` 등)를 사용할 수 있습니다.

> **⚠️ Node.js 필수:** bun이 기본 러너이지만, `postinstall` 스크립트
> (`node scripts/fetch-uv.mjs`)와 Electron 실행 스크립트
> (`scripts/run-electron.mjs`)는 시스템 `node` CLI를 직접 호출합니다.
> Electron 내장 Node는 PATH의 `node` 바이너리를 대체하지 않으므로,
> **개발자 머신에 Node.js v18 이상**이 별도로 설치되어 있어야 합니다.

## Windows (사내망) 실행 가이드

Windows corp PC(사내망, Hyper-V/VDI, EDR/AV 샌드박스 환경)에서의 first-run 경험을 단순화하기 위해 `scripts/run-electron.mjs` 가 다음을 자동 처리합니다.

- **GPU 문제 우회** — Electron GPU 프로세스가 `error_code=18` 로 크래시하는 것을 막기 위해 `--disable-gpu --use-angle=swiftshader --no-sandbox --in-process-gpu` 등 SwiftShader 기반 소프트웨어 렌더링 플래그를 자동 추가합니다. GPU 정상 환경(패스스루 VM / CI)에서는 `LVIS_KEEP_GPU=1` 로 opt-out.
- **플러그인 경로 허용** — `LVIS_DEV=1` + `LVIS_DEV_SKIP_SIG=1` 을 기본값으로 세팅해, `file:../` 로 설치된 사이드바이사이드 플러그인(`../lvis-plugin-*`)이 플러그인 루트 경계 검사에서 거부되지 않도록 합니다. 패키징 빌드(`app.isPackaged`)에서는 자동 off.
- **콘솔 UTF-8 정렬** — Windows 콘솔을 `chcp 65001` 로 UTF-8 로 전환하고 `PYTHONIOENCODING=utf-8`, `PYTHONUTF8=1`, `LANG/LC_ALL=en_US.UTF-8` 환경변수를 기본 주입합니다. cp949 로 인한 한글/이모지 깨짐이 사라집니다.

### 권장 설치 절차 (사내망)

```powershell
# 1) submodule 까지 포함해 clone
git clone --recurse-submodules <repo-url>
cd lvis-app

# 2) file:../ symlink 대신 복사로 설치해 EISDIR 회피
npm install --legacy-peer-deps --install-links=true

# 3) 빌드 + 실행 (bun 이 없어도 동작)
npm run start:npm
```

`postinstall` 훅(`scripts/ensure-submodules.mjs`)이 submodule 디렉터리가 비어 있으면 `git submodule update --init --recursive` 를 실행하고, `packages/plugin-sdk` 처럼 `package.json` 은 있으나 `dist/` 가 없는 submodule 은 자동으로 `npm install && npm run build` 를 수행합니다. 따라서 fresh clone 직후 `@lvis/plugin-sdk/keys` 미존재로 main 프로세스가 실패하지 않습니다.

### 사내망 환경변수 요약

| 변수 | 기본값 | 목적 |
|------|--------|------|
| `LVIS_DEV` | `1` (unpackaged) | 플러그인 루트 경계 검사 완화 (`../../../node_modules/@lvis/*` 허용) |
| `LVIS_DEV_SKIP_SIG` | `1` (unpackaged) | 로컬 빌드 플러그인 서명 검증 skip |
| `LVIS_KEEP_GPU` | 미설정 | `1` 이면 Windows GPU safe-flag 주입 skip |
| `LVIS_SKIP_CORP_CA` | 미설정 | `1` 이면 macOS 키체인 CA 추출도 skip (해외망/비-LG 네트워크) |
| `LVIS_CORP_CA_DEBUG` | 미설정 | `1` 이면 Windows/Linux CA 추출 Phase 3 pending 로그 표시 |
| `PYTHONIOENCODING` | `utf-8` | Python subprocess 출력 UTF-8 고정 |

## 테스트
```bash
bun run test:electron-smoke
bun run test:plugin-flow
bun run test:meeting-flow
bun run test:main-flow
bunx vitest run
```

## 실행
```bash
# 실제 PageIndex 모드 (설치/키 필요)
# PAGEINDEX_ROOT=/absolute/path/to/PageIndex OPENAI_API_KEY=... bun run start

# 테스트 모드(기본): 외부 LLM 없이 로컬 Markdown 기준 검증
LVIS_PAGEINDEX_TEST_MODE=1 bun run start
```
