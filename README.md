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
npm run plugins:list
npm run plugins:install -- <plugin-id>
npm run plugins:add -- <plugin-id> <manifest-path>
npm run plugins:remove -- <plugin-id>
npm run plugins:enable -- <plugin-id>
npm run plugins:disable -- <plugin-id>
```

예시:
```bash
npm run plugins:install -- meeting
npm run plugins:add -- search search/plugin.json
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

캘린더 데이터는 앱 부팅 시 `calendar_list`를 통해 로드되어 캐시에 저장됩니다 (`calendarEventsCache`).  
`getBriefingPromptData()`는 오늘 일정 요약 텍스트(최대 8건)를 LLM 프롬프트에 자동으로 포함합니다.

### 캘린더 플러그인 선제성 기능 (5가지)

| # | 기능 | 트리거 | 출력 이벤트 |
|---|------|--------|------------|
| 1 | **미팅 15분 전 LLM 브리핑** | `calendar.event.upcoming` 이벤트 | `calendar.prebriefing.ready` → Electron 알림 |
| 2 | **일정 생성 시 충돌 감지** | `calendar_create` 호출 | 응답에 `conflictWarning`, `alternativeSlots` 포함 |
| 3 | **이메일 → 미팅 요청 자동 감지** | `email.action.needed` 이벤트 | `calendar.from_email.suggested` → Electron 알림 |
| 4 | **월요일 주간 일정 요약** | 앱 부팅 (월요일) | ProactiveEngine 캐시 갱신 |
| 5 | **반복 패턴 감지** | `calendar_detect_patterns` 호출 | `calendar.pattern.detected` 이벤트, UI에 표시 |

### 플러그인 LLM 접근 (`callLlm`)

플러그인이 직접 LLM을 호출할 수 있도록 `HostApi`에 `callLlm` 메서드가 제공됩니다:

```typescript
hostApi.callLlm(prompt: string, options?: { maxTokens?: number; systemPrompt?: string }): Promise<string>
```

- `boot.ts`에서 `llmCallerRef`(lazy reference) 패턴으로 `ConversationLoop.generateText()`에 연결
- 플러그인 로드 시점에는 LLM이 아직 초기화되지 않을 수 있으므로, 실제 호출 시점에 바인딩됨
- 미팅 브리핑 생성, 이메일 분석 등 플러그인 레벨 LLM 추론에 활용

### 이벤트 버스

선제성 기능은 `emitEvent` / `onEvent` 기반 비동기 이벤트 버스로 통신합니다:

| 이벤트 | 발행자 | 구독자 |
|--------|--------|--------|
| `calendar.event.upcoming` | CalendarWatcher | calendar hostPlugin |
| `calendar.prebriefing.ready` | calendar hostPlugin | boot.ts (Electron 알림) |
| `calendar.from_email.suggested` | calendar hostPlugin | boot.ts (Electron 알림) |
| `calendar.pattern.detected` | calendar hostPlugin | calendar UI |
| `email.action.needed` | email hostPlugin | calendar hostPlugin |
| `meeting.ended` | meeting hostPlugin | calendar hostPlugin |

### 매니페스트 선언형 계약

플러그인은 `plugin.json`에서 선제성 동작을 선언합니다:

```json
{
  "capabilities": ["calendar-source", "background-watcher"],
  "startupMethods": ["calendar_start_watcher"],
  "eventSubscriptions": [
    "calendar.event.upcoming",
    "calendar.prebriefing.ready",
    "calendar.from_email.suggested",
    "calendar.pattern.detected"
  ]
}
```

`boot.ts`는 `runManifestStartupMethods()` / `registerManifestEventSubscriptions()`으로 이를 자동 처리합니다. 플러그인별 하드코딩 없음.

## 설치
```bash
npm install
```

## 테스트
```bash
npm run test:electron-smoke
npm run test:plugin-flow
npm run test:meeting-flow
npm run test:main-flow
```

## 실행
```bash
# 실제 PageIndex 모드 (설치/키 필요)
# PAGEINDEX_ROOT=/absolute/path/to/PageIndex OPENAI_API_KEY=... npm run start

# 테스트 모드(기본): 외부 LLM 없이 로컬 Markdown 기준 검증
LVIS_PAGEINDEX_TEST_MODE=1 npm run start
```
