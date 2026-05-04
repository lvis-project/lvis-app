# LVIS Agent Hub Plugin — Implementation Plan

> **Scope.** v3 mockup (`lvis-app/docs/design/agent-hub-work-board-v3.html`) 합의 결과를 production plugin 으로 구현. 기존 `lvis-plugin-agent-hub` repo 를 활용하고, host 측 §8 ApprovalGate 와 ms-graph plugin 의 calendar method 를 재사용한다. 본 계획은 9 Lane × 4 Wave 로 worker 격리 dispatch 를 가정한다.
> **Status.** Plan only. 본 문서가 구현 코드를 포함하지 않는다. 각 lane 의 dispatch prompt 까지가 산출물.

---

## Section 1. Goal & Non-Goal

### 1.1 Goal

1. v3 mockup 의 6 영역 (마이워크 3 row + 팀보드 3 row) 을 plugin UI 로 구현해 host viewport slot 안에 mount 한다.
2. `lvis-plugin-ms-graph` 의 `msgraph_calendar_today` / `msgraph_calendar_list` 를 HostApi `callTool` 로 호출해 일정 카드를 채운다 (자체 SDK 금지).
3. 승인 요청 카드 + 컨펌 모달은 host §8 ApprovalGate 와 bridge 한다 — plugin 자체 approval queue 를 만들지 않는다.
4. LLM 5줄 분석 카드는 plugin 진입 시 1회 trigger 한다 (Proactive Engine 연계 X).
5. 9 lane × 4 wave 격리 dispatch 가 가능한 산출물 단위로 쪼갠 task 를 정의한다.
6. 모든 worker 는 canonical `lvis-plugin-agent-hub/` 에 직접 쓰지 않고 `/tmp/agent-hub/L<n>/` fresh clone 에서 작업한다.
7. CLAUDE.md 의 No-Fallback / Research-First / parallel agent isolation 규율을 모든 lane prompt 에 명시한다.

### 1.2 Non-Goal

- 새로운 plugin repo 생성 금지 (D4: 기존 `lvis-plugin-agent-hub` 활용 확정).
- detached BrowserWindow 모드 추가 금지 (D1: host viewport slot 만). 기존 manifest 의 `"window.defaultMode": "detached"` 설정은 본 계획 안에서 `"embedded"` 로 변경하거나 제거한다.
- ms-graph 외 외부 calendar/email source 추가 금지.
- Proactive Engine 의 5 signal coordinator 연동 금지.
- backend hub server (Agent Hub FastAPI) 의 endpoint / contract 변경 금지 — 본 plan 은 client side only.
- 새 LLM provider 통합 금지 — `hostApi.callLlm` 사용.
- v3 mockup 에 없는 UI 요소 (예: notification toast, pagination dot indicator) 추가 금지. v3 의 "합의 필요 항목" 6건 은 별도 follow-up.

---

## Section 2. 현재 상태 점검 (A1–A4)

### A1. `lvis-plugin-agent-hub` 기존 코드 상태 (read-only explore)

**파일 인덱스 (canonical, Sprint 0 시점 기준):**

| 경로 | 역할 | v3 대비 상태 |
|------|------|----|
| `plugin.json` | manifest, 22 tools, configSchema 6 keys | tools 충분. UI slot `kind=embedded-module` + `window.defaultMode=detached` — **수정 필요** |
| `src/hostPlugin.ts` | runtime entry, handler wiring, polling lifecycle | 골격 그대로 활용 가능 |
| `src/types.ts` | `AgentHubConfig`, `WorkLogPayload`, `ApprovalRequestResponse` 등 backend wire types | 그대로 활용 |
| `src/hubClient.ts` | FastAPI 호출 래퍼 (`/api/v1/work-logs`, `/api/v1/approval-requests`, `/api/v1/team-channels` 등) | 그대로 활용 |
| `src/aggregator.ts` | mail / meeting / calendar / routine snapshot 누적기 | 그대로 활용. v3 의 "처리 필요 신호" 카드의 source. |
| `src/inbox.ts` | hub inbox polling → host `addTask` fan-out | 그대로 활용 |
| `src/schedule.ts` | KST Sunday-anchored 주 경계 (`sundayWeekBoundsKst`) | 그대로 활용 |
| `src/auth/token-store.ts` | encrypted token cache + `me.department.code` capture | 그대로 활용 (S0–S2 의 백본) |
| `src/tools/work-board.ts` | `myWorkBoardHandler`, `teamWorkBoardHandler` — production normalize, no-mock-fallback 정책 | 그대로 활용 |
| `src/tools/approvals.ts` | backend approval-request CRUD | 그대로 활용 (팀보드 승인함 탭이 기존에 사용) |
| `src/tools/team-channel.ts` | `/api/v1/team-channels` post/list/subscribe + `/me/feed` | 그대로 활용 |
| `src/tools/messages.ts`, `subscribe-team.ts`, `generate-weekly-report.ts`, `post-work-log.ts`, `check-inbox.ts`, `list-inbox.ts`, `my-recent-logs.ts`, `status.ts` | 부수 tool handlers | 그대로 활용 |
| `src/ui/agent-hub-panel.ts` | DOMParser-기반 "업무 보드" panel (1599 lines, tabs: My Work / Team Work / 승인함 / 팀 채널) | **v2.1 IA 의 결과물** — v3 3-row 구조와 다르다. **본 plan 의 UI 작업은 이 파일을 _덮어쓰지_ 않고 새 entry 로 대체** (Lane 6) |

**근거 인용 (`src/hostPlugin.ts`):**

```ts
// src/hostPlugin.ts L283-297 — calendar pre-load via hostApi.callTool
const today = await context.hostApi.callTool<unknown[]>("msgraph_calendar_today", {});
```

→ 이미 ms-graph 의 method 를 callTool 로 호출하는 패턴이 동작 중. v3 의 "오늘 일정" 카드도 동일 entry-point 사용.

**근거 인용 (`plugin.json` L97-110):**

```json
"ui": [{
  "id": "agent-hub-panel",
  "slot": "sidebar",
  "kind": "embedded-module",
  "displayName": "업무 보드",
  "entry": "dist/ui/agent-hub-panel.js",
  "exportName": "mount",
  "window": { "defaultMode": "detached" }
}]
```

→ Lane 1 에서 이 ui entry 를 v3 의 3-row layout 으로 갈아끼우고 `window.defaultMode` 를 제거 (D1 결정).

**근거 인용 (`src/hostPlugin.ts` L96-108) — config merge 패턴:**

```ts
const configSchemaKeys = [
  "hubServerUrl", "employeeId", "defaultPostScope",
  "inboxPollIntervalMs", "autoPostOnShutdown", "maxAggregatorItems",
];
for (const key of configSchemaKeys) {
  const v = getConfig?.(key);
  if (v !== undefined && v !== null) rawConfig[key] = v;
}
```

→ §9.2 Track B 합치 패턴은 이미 적용. Lane 2 가 새 config key 를 추가할 경우 이 list 에도 함께 추가 (No-Fallback 룰: schema + merge list 같은 PR).

### A2. `lvis-plugin-ms-graph` 의 calendar method 노출 여부

**확인 결과:** 이미 12+ calendar tool 이 manifest 에 노출되어 있고, agent-hub plugin 은 manifest `pluginAccess.plugins[].tools` 에 `msgraph_calendar_today` 1건만 화이트리스트에 올려놓은 상태.

**근거 인용 (`lvis-plugin-ms-graph/plugin.json`):**

```
"tools": [
  "msgraph_calendar_append_body", "msgraph_calendar_create",
  "msgraph_calendar_create_invite_event", "msgraph_calendar_delete",
  "msgraph_calendar_detect_patterns", "msgraph_calendar_find_by_correlation_key",
  "msgraph_calendar_find_by_time_range", "msgraph_calendar_get",
  "msgraph_calendar_list", "msgraph_calendar_open_url",
  "msgraph_calendar_start_watcher", "msgraph_calendar_stop_watcher",
  "msgraph_calendar_today", "msgraph_calendar_update",
  ...
]
```

**근거 인용 (`lvis-plugin-agent-hub/plugin.json` L17-25):**

```json
"pluginAccess": {
  "plugins": [{
    "pluginId": "ms-graph",
    "tools": ["msgraph_calendar_today"],
    "events": ["email.action.needed"]
  }]
}
```

**v3 요구사항 매핑:**

| v3 카드 | 필요 ms-graph tool | 현재 화이트리스트 | 액션 |
|------|---|---|---|
| 마이워크 Row 2 "오늘 일정" (Outlook) | `msgraph_calendar_today` | 있음 | 그대로 |
| 팀보드 Row 1 "오늘 팀원 전체 일정" | `msgraph_calendar_list` (date range + attendees aggregate) | 없음 | **추가 필요** |
| (선택) 일정 정정 confirm modal action | `msgraph_calendar_update` | 없음 | **Lane 5 가 승인 후 호출 시 추가 필요** |

→ Lane 4 (팀보드 데이터) 에서 `pluginAccess.plugins[].tools` 에 `msgraph_calendar_list` 추가. Lane 5 가 confirm-modal 의 "일정 일괄 수정" action 을 실행할 때 `msgraph_calendar_update` 도 추가. 두 항목 모두 manifest schema PR 에서 함께 처리 (No-Fallback 룰).

### A3. host §8 ApprovalGate API 인터페이스

**확인 결과:** `src/permissions/approval-gate.ts` 가 main process 에 ApprovalGate class 를 두고, renderer 와 IPC channel `lvis:approval:request` / `lvis:approval:respond` 로 양방향 통신. nonce + HMAC-SHA256 으로 confused-deputy 방어. timeout 5분 default. 일부 path 는 sensitive-path hard-block.

**근거 인용 (`src/permissions/approval-gate.ts`):**

```ts
export const IPC_APPROVAL_REQUEST = "lvis:approval:request";
export const IPC_APPROVAL_RESPOND = "lvis:approval:respond";

export interface ApprovalRequest {
  id: string;
  category: "tool";
  toolName: string;
  args: unknown;
  reason: string;
  source?: "builtin" | "plugin" | "mcp";
  // ...
  nonce?: string;   // §D2 confused-deputy nonce
  hmac?: string;    // HMAC-SHA256(sessionKey, `${id}|${nonce}|${canonicalArgs}`)
}

export type ApprovalChoice = "allow-once" | "allow-always" | "deny-once" | "deny-always";
```

**중요 관찰:** ApprovalGate 는 toolName 과 args 를 받는 _tool_ 카테고리만 지원. v3 "승인 요청 카드" 는 사용자가 _이미 plugin 안에 표시된 항목_ 을 클릭해서 컨펌 모달을 띄우는 흐름. 즉 plugin 이 backend `agent_hub_list_approvals(role='approver', status='pending')` 로 가져온 ApprovalRequest 항목을 카드에 그리고, 사용자가 "승인" 버튼을 눌렀을 때 plugin → host 로 _승인 의도_ 를 전달.

**§8 와의 정확한 bridge 모델:** plugin 은 자체 approval queue 가 아니다. plugin 이 backend 에서 가져오는 `ApprovalRequestResponse` 의 _ack/decision_ 을 host §8 ApprovalGate 의 `requestAndWait()` 호출로 한 번 더 감싼다 — 즉 사용자가 plugin UI 의 "승인" 버튼을 누르면, plugin 이 `agent_hub_decide_approval` 을 _바로_ 호출하지 않고, _host §8 ApprovalGate 를 통해서_ "이 backend approval row 를 결정하시겠습니까" 라는 OS-level 승인 모달을 한 번 더 띄운 뒤 사용자가 OK 했을 때만 backend decision API 를 친다. 이렇게 하면:

- 사용자가 OS-native 모달에서 두 번째 confirm 을 한다 (D3 의 "host §8 와 bridge" 충족).
- audit log 가 host 측 audit-logger 에 한 번, backend 에 한 번 — 두 군데 다 남는다.
- DLP filter / sensitive-path block 이 자동 적용된다.

**Renderer 측 호출 진입점 — Lane 5 가 사용할 IPC bridge:**

`src/permissions/agent-action-requester.ts` 는 현재 비어 있음 (skeleton 미구현 상태로 존재). Lane 5 가 이 파일에 `requestAgentApproval(toolName, args, reason)` 함수를 추가하고, plugin webview 의 preload bridge (`window.lvisPlugin`) 가 `requestAgentApproval` 을 호출할 수 있게 expose. 즉 plugin → preload → main → ApprovalGate → renderer modal → 사용자 → main → preload → plugin 의 한 turn.

→ Lane 5 는 host 측 PR (lvis-app) + plugin 측 PR (lvis-plugin-agent-hub) 두 개로 나뉜다.

### A4. 설정 항목 default 4건 명세

**기존 `configSchema` (manifest, 6 entries):**

1. `hubServerUrl` (string, default `https://agent-hub.lvisai.xyz`)
2. `employeeId` (string, default `""`)
3. `defaultPostScope` (enum personal/team/org/global, default `personal`)
4. `inboxPollIntervalMs` (integer 0–3,600,000, default `300_000`)
5. `autoPostOnShutdown` (boolean, default `false`)
6. `maxAggregatorItems` (integer 10–500, default `50`)

**v3 가 신규 요구하는 setting 4건:**

| 키 | 타입 | default | 의미 | UI 위치 |
|---|---|---|---|---|
| `appBarToggleDefault` | enum (`"my-work"` / `"team-board"`) | `"my-work"` | plugin 첫 mount 시 어떤 view 가 active 인가 (v3 알약 토글 default) | 톱니 ⚙ 메뉴 |
| `llmBriefingMaxTokens` | integer 256–2048 | `768` | 마이워크 Row 1 LLM 5줄 분석 카드의 hostApi.callLlm() maxTokens | 톱니 ⚙ 메뉴 |
| `cardScrollMaxHeight` | integer 120–400 | `200` | 6 영역 내부 스크롤 max-height (px). v3 "scrollable · n/total" 패턴의 임계점 | 톱니 ⚙ 메뉴 |
| `riskColorOverride` | string (CSS color, format `^#[0-9a-fA-F]{6}$` or empty) | `""` (= use `--red`) | 일관 risk red 색상 override | 톱니 ⚙ 메뉴 (advanced) |

→ Lane 1 에서 manifest `configSchema` 와 Lane 7 의 store 가 동시에 add 한다 (No-Fallback: schema + 소비처 같은 PR).

**참고: §9.2 Track B 머지 룰** — `src/hostPlugin.ts` 의 `configSchemaKeys` 배열에 4건 추가 필요. 빠뜨리면 `getConfig` 가 동작하지 않아 default 만 보이는 silent fallback 이 발생.

---

## Section 3. Architecture (4-Layer)

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1 — UI                                                │
│ ─────────────────────────────────────────────────────────── │
│ Plugin UI mount entry (host viewport slot, embedded module) │
│ React + DOMParser hybrid (existing pattern in agent-hub)    │
│                                                             │
│   AppBar.tsx        ─ 알약 토글 + 톱니                       │
│   MyWorkView.tsx    ─ Row1/Row2/Row3 그리드                  │
│     LlmBriefingCard.tsx                                     │
│     ApprovalRequestCard.tsx (chevron + footer)              │
│     WeeklyGanttCard.tsx                                     │
│     TodayScheduleCard.tsx                                   │
│     MyBoardCard.tsx                                         │
│   TeamBoardView.tsx ─ Row1/Row2/Row3 그리드                  │
│     TeamKpiCombo.tsx (KPI 4 + member mini rows)             │
│     TeamScheduleCard.tsx (참석자 avatar 스택)                │
│     TeamSummaryCard.tsx (성과 / 리스크 paragraph)            │
│     TeamBoardListCard.tsx                                   │
│   ConfirmModal.tsx (승인 요청 클릭 → 모달)                   │
│   States/                                                   │
│     S0LoginPrompt.tsx                                       │
│     S2SyncingState.tsx                                      │
│     S5PartialSync.tsx                                       │
└──────────────────────────┬──────────────────────────────────┘
                           │ bridge.callTool / bridge.onEvent
┌──────────────────────────┴──────────────────────────────────┐
│ Layer 2 — State (in-renderer)                               │
│ ─────────────────────────────────────────────────────────── │
│ Zustand store + selectors (Lane 7)                          │
│   useAgentHubStore                                          │
│     auth: AuthLoadState                                     │
│     myWork: { llm, approvals, weekGantt, schedule, board }  │
│     teamBoard: { kpi, members, schedule, summary, list }    │
│     ui: { activeView, settingsPanelOpen, confirmModal }     │
│     timestamps: { lastBriefingAt, lastSyncAt }              │
│   actions: loadAll, loadMyWork, loadTeamBoard, ...          │
└──────────────────────────┬──────────────────────────────────┘
                           │ async dispatch
┌──────────────────────────┴──────────────────────────────────┐
│ Layer 3 — Domain (plugin sandbox)                           │
│ ─────────────────────────────────────────────────────────── │
│ Existing handlers (src/tools/*) + 신규 aggregator/transform │
│   work-board.ts          ─ keep                             │
│   team-channel.ts        ─ keep                             │
│   approvals.ts           ─ keep                             │
│   NEW: tools/team-kpi.ts ─ aggregate per-member KPI         │
│   NEW: tools/today-team-schedule.ts                         │
│        ─ msgraph_calendar_list 의 attendees 합쳐 가공        │
│   NEW: tools/llm-briefing.ts                                │
│        ─ 1회 진입 시 hostApi.callLlm + 5줄 prompt           │
│   NEW: tools/weekly-gantt.ts                                │
│        ─ work-log + my-recent-logs 합쳐 gantt row 정규화     │
└──────────────────────────┬──────────────────────────────────┘
                           │ HostApi
┌──────────────────────────┴──────────────────────────────────┐
│ Layer 4 — Integration                                       │
│ ─────────────────────────────────────────────────────────── │
│   hubClient.ts          ─ Agent Hub backend FastAPI         │
│   hostApi.callTool      ─ ms-graph methods                  │
│   hostApi.callLlm       ─ vendor-agnostic LLM               │
│   hostApi.openAuthWindow─ S0–S2 web login                   │
│   §8 bridge             ─ ApprovalGate via                  │
│                           agent-action-requester.ts (Lane 5)│
│   manifest pluginAccess ─ ms-graph calendar tools화이트리스트│
└─────────────────────────────────────────────────────────────┘
```

**Layer 책임 요약:**

- **Layer 1 (UI)** — DOMParser 기반 정적 markup 패턴은 v3 의 6 영역 동시 표시 + tab navigation + 내부 스크롤 6 곳 으로 폭증한다. v3 부터는 **React + jsx** 로 전환한다 (Lane 6). 단 plugin entry 는 여전히 DOM mount 함수 (`mount(context)`) 형태 — Lane 6 가 React renderer 를 root 에 mount 한다.
- **Layer 2 (State)** — Zustand. v3 의 6 영역이 partial-sync 상태에서 각자 독립적으로 ready/loading/error 를 가질 수 있어야 함 (S5 의 명시 요구사항: "사용자는 무엇이 실패했는지, 현재 어떤 데이터가 보이는지, 다음으로 무엇을 누르면 되는지" 알아야 한다).
- **Layer 3 (Domain)** — backend wire shape 을 v3 카드의 props 로 normalizing. 기존 `myWorkBoardHandler` / `teamWorkBoardHandler` 를 _확장_ 하지 않고 _병행_ 하는 새 transform 모듈을 추가 (기존 v2.1 이 backend test snapshot 과 lock-in 되어 있어 safer).
- **Layer 4 (Integration)** — host ↔ plugin 의 모든 cross-process 호출. plugin 안에서 host service 에 직접 접근하는 코드는 이 layer 안에서만 허용 (Layer 3 는 client/aggregator 만 사용).

---

## Section 4. Plugin Manifest 초안

> 기존 `plugin.json` 을 baseline 으로 잡고, **추가/변경 항목만** 기술. 기존 22 tool 은 모두 유지.

```json
{
  "id": "agent-hub",
  "name": "LVIS Agent Hub",
  "version": "0.2.0",                           // 0.1.27 → 0.2.0 (UI v3 break)
  "publisher": "LG Electronics IT",
  "installPolicy": "user",
  "entry": "dist/hostPlugin.js",
  "description": "사원 에이전트 보드 — v3 마이워크/팀보드 통합 UI, 승인 bridge, 팀 KPI, 일정 합본",

  "dependencies": [
    { "pluginId": "ms-graph", "required": true }   // calendar-list 의존이 strict 해짐
  ],

  "pluginAccess": {
    "plugins": [
      {
        "pluginId": "ms-graph",
        "tools": [
          "msgraph_calendar_today",                // 기존
          "msgraph_calendar_list",                 // ★ ADD — 팀보드 today schedule
          "msgraph_calendar_update"                // ★ ADD — 일정 일괄 수정 confirm
        ],
        "events": ["email.action.needed"]
      },
      { "pluginId": "meeting", "events": ["meeting.summary.created", "meeting.ended"] }
    ]
  },

  "tools": [
    /* 기존 22 + 5 추가 */
    "agent_hub_auth", "agent_hub_signout", "agent_hub_status",
    "agent_hub_post_work_log", "agent_hub_generate_weekly_report",
    "agent_hub_generate_team_weekly_report", "agent_hub_subscribe_team",
    "agent_hub_check_inbox", "agent_hub_my_recent_logs",
    "agent_hub_my_work_board", "agent_hub_team_work_board",
    "agent_hub_list_inbox", "agent_hub_dismiss_notifications",
    "agent_hub_send_message", "agent_hub_list_messages",
    "agent_hub_request_approval", "agent_hub_list_approvals",
    "agent_hub_decide_approval",
    "agent_hub_list_team_channel_posts", "agent_hub_post_team_channel",
    "agent_hub_team_channel_subscribe", "agent_hub_my_feed",

    /* ★ ADD — v3 implementation 신규 5건 */
    "agent_hub_my_work_board_v3",            // v2.1 의 my_work_board + v3 카드 추가 정규화
    "agent_hub_team_board_v3",               // 팀 KPI + member rows + summary 통합
    "agent_hub_today_team_schedule",         // ms-graph calendar-list aggregate
    "agent_hub_briefing_summarize",          // hostApi.callLlm 5줄 분석
    "agent_hub_decide_approval_with_host"    // §8 ApprovalGate bridge wrapper
  ],

  "uiCallable": [
    /* ... 기존 ... */
    "agent_hub_my_work_board_v3",
    "agent_hub_team_board_v3",
    "agent_hub_today_team_schedule",
    "agent_hub_briefing_summarize",
    "agent_hub_decide_approval_with_host"
  ],

  "ui": [
    {
      "id": "agent-hub-panel",
      "slot": "sidebar",
      "kind": "embedded-module",
      "displayName": "업무 보드",
      "title": "Agent Hub 업무 보드",
      "description": "마이워크/팀보드 v3 — 3-row 압축 layout",
      "entry": "dist/ui/agent-hub-panel-v3.js",     // ★ NEW entry — v2.1 panel 과 병행
      "exportName": "mount"
      /* ★ window.defaultMode 제거 — D1 결정에 따라 host viewport slot 만 */
    }
  ],

  "configSchema": {
    "properties": {
      /* 기존 6건 */
      "hubServerUrl": { "type": "string", "default": "https://agent-hub.lvisai.xyz", "format": "uri" },
      "employeeId": { "type": "string", "default": "" },
      "defaultPostScope": { "type": "string", "enum": ["personal","team","org","global"], "default": "personal" },
      "inboxPollIntervalMs": { "type": "integer", "default": 300000, "minimum": 0, "maximum": 3600000 },
      "autoPostOnShutdown": { "type": "boolean", "default": false },
      "maxAggregatorItems": { "type": "integer", "default": 50, "minimum": 10, "maximum": 500 },

      /* ★ ADD — v3 신규 4건 */
      "appBarToggleDefault": {
        "type": "string", "enum": ["my-work","team-board"], "default": "my-work",
        "title": "기본 view", "description": "plugin 첫 mount 시 active 한 알약 토글"
      },
      "llmBriefingMaxTokens": {
        "type": "integer", "minimum": 256, "maximum": 2048, "default": 768,
        "title": "LLM 분석 max tokens", "description": "마이워크 Row 1 LLM 카드의 callLlm maxTokens"
      },
      "cardScrollMaxHeight": {
        "type": "integer", "minimum": 120, "maximum": 400, "default": 200,
        "title": "카드 내부 스크롤 max-height (px)",
        "description": "6 영역 내부 스크롤 임계점. v3 의 'scrollable · n/total' 패턴이 발동하는 픽셀 높이"
      },
      "riskColorOverride": {
        "type": "string", "default": "",
        "pattern": "^(#[0-9a-fA-F]{6})?$",
        "title": "리스크 강조 색 override",
        "description": "비워두면 v3 default --red (#f78166). 사내 색상 토큰 사용 시 6자리 hex"
      }
    }
  },

  "capabilities": [
    "conversation-trigger",                  // 기존 — proactive 미사용이지만 capability 남겨둠
    "external-auth-consumer"                 // 기존
  ],

  "eventSubscriptions": [
    "lvis:routine:completed",
    "meeting.summary.created",
    "meeting.ended",
    "email.action.needed"
  ],

  "emittedEvents": [
    /* 기존 */
    "agent_hub.work_log.posted",
    "agent_hub.work_log.pending_approval",
    "agent_hub.team_feed.received",
    "agent_hub.weekly_report.generated",
    "agent_hub.notification.received",
    "agent_hub.auth.changed",

    /* ★ ADD — 단일-PR 선언+발행 강제 (validate-events.mjs) */
    "agent_hub.briefing.generated",          // Lane 3 PR 에서 추가 + 발행, 본 PR 미포함
    "agent_hub.approval.bridged"             // Lane 5 PR 에서 추가 + 발행, 본 PR 미포함
  ],

  "auth": {
    "label": "Agent Hub",
    "statusTool": "agent_hub_status",
    "loginTool": "agent_hub_auth",
    "logoutTool": "agent_hub_signout"
  }
}
```

**Manifest 변경 영향 매트릭스:**

| 항목 | Lane | PR scope |
|------|------|----------|
| `version` 0.2.0 bump | Lane 1 | manifest + package.json + RELEASING.md |
| `pluginAccess.plugins[].tools` 2건 추가 | Lane 4 | manifest + AJV schema sweep |
| 신규 5 tool 추가 + uiCallable 5건 | Lane 3+4+5 | tool handler 파일 + manifest 동기 |
| `ui.entry` 변경 + `window.defaultMode` 제거 | Lane 1, Lane 6 | manifest + tsup config + UI bundle 출력 경로 |
| `configSchema` 4 key 추가 | Lane 1 + Lane 7 | manifest + hostPlugin.ts configSchemaKeys + Zustand store reader |
| `emittedEvents` 2건 추가 | Lane 3, Lane 5 | manifest + emit site |

---

## Section 5. Tool 명세

> Layer 3 의 Domain 모듈로 5건 추가. 각 항목은 `(toolName, input, output, source)` 형식. 기존 22 tool 은 docs/blueprints 외 위치에 명세가 있으므로 본 plan 에서는 신규만 자세히 다룸.

### 5.1 `agent_hub_my_work_board_v3`

- **호출 source.** UI direct call (mount 시 + refresh 시).
- **Input.**
  ```ts
  { weekOffset?: number; limit?: number; }   // myWorkBoardHandler 와 동일
  ```
- **Output.** `MyWorkBoardV3Result`:
  ```ts
  {
    mock: false; source: "agent-hub"; generatedAt: string;
    weekStart: string; weekEnd: string;
    status: "ok" | "empty";
    rows: {
      llmBriefing: BriefingPayload | null;        // null 이면 카드 자체 안 그림
      approvals: { count: number; items: Pick<ApprovalRequestResponse,
                    "id"|"title"|"action_type"|"target_scope"|"created_at">[]
                  };
      weekGantt: { rows: GanttRow[]; total: number; visibleCount: number };
      todaySchedule: { items: CalendarItemV3[]; total: number; visibleCount: number };
      myBoard: { rows: TaskRowV3[]; total: number; visibleCount: number };
    };
    message?: string;     // status==="empty" 일 때 인간 가독 사유
  }
  ```
- **Body.** 기존 `myWorkBoardHandler` + `agent_hub_briefing_summarize` (mount-once gate 는 store 가 강제) + `agent_hub_today_team_schedule` 의 _자기 자신 only_ slice 합본. 모든 카드의 _total_ 과 _visibleCount_ 분리 (v3 의 "scrollable · n/total" pattern 충족).

### 5.2 `agent_hub_team_board_v3`

- **호출 source.** UI direct call.
- **Input.**
  ```ts
  { teamCode?: string; weekOffset?: number; }
  ```
- **Output.** `TeamBoardV3Result`:
  ```ts
  {
    mock: false; source: "agent-hub"; generatedAt: string;
    weekStart: string; weekEnd: string;
    status: "ok" | "empty" | "no-team";
    teamCode: string | null;
    subscribedTeams: string[];
    rows: {
      kpi: { inProgress: number; planned: number; done: number; risk: number };
      members: TeamMemberKpi[];                    // member 당 4 pill counts
      todaySchedule: { items: TeamCalendarItemV3[]; total: number; visibleCount: number };
      summary: { wins: { count: number; paragraph: string };
                 risks: { count: number; paragraph: string } };
      list: { rows: TeamTaskRowV3[]; total: number; visibleCount: number };
    };
    message?: string;
  }
  ```
- **Body.** 기존 `teamWorkBoardHandler` + `agent_hub_today_team_schedule` 팀-단위 + LLM-driven summary paragraph (selectable: 팀-summary 는 별도 LLM call 필요시 `agent_hub_briefing_summarize` 와 다른 system prompt; v3 의 "주요 성과 / 이슈·리스크 paragraph + 카운팅" 충족).
- **No-Fallback.** `status==="no-team"` 일 때도 _절대 mock_ 으로 채우지 않는다 — 기존 `teamWorkBoardHandler` 의 "no-team-fallback never" 정책 유지.

### 5.3 `agent_hub_today_team_schedule`

- **호출 source.** Direct (UI). LLM tool catalog 에는 노출하지 않음 (uiCallable only — v3 layout 데이터 fetcher 라 LLM 이 부르면 토큰 낭비).
- **Input.**
  ```ts
  { teamCode?: string; date?: string /* ISO date, default today KST */; }
  ```
- **Output.**
  ```ts
  {
    items: Array<{
      title: string;
      startsAt: string;
      durationMin: number;
      attendees: Array<{ employeeCode: string; name: string; avatarText: string }>;
      attendeeCountTotal: number;       // attendees.length 일 수도, 더 클 수도 있음 — v3 "+9명" overflow
    }>;
    total: number;
    visibleCount: number;
  }
  ```
- **Body.** 내부적으로 `hostApi.callTool("msgraph_calendar_list", { since, until, includeAttendees: true })` 호출 → ms-graph 응답을 v3 attendee avatar 스택용 shape 로 transform.

### 5.4 `agent_hub_briefing_summarize`

- **호출 source.** Direct (UI mount-once + manual refresh). LLM tool catalog 에는 _노출하지 않음_ — v3 의 "1회 진입 시 LLM" 의도 (D5).
- **Input.**
  ```ts
  {
    aggregatorSnapshot: AggregatorSnapshot;     // mail/meeting/calendar/routine
    myWorkBoardSnapshot: MyWorkBoardV3Result;   // 7 day 일지 + approvals 등
    maxTokens?: number;                          // configSchema.llmBriefingMaxTokens default
    systemPromptOverride?: string;               // 사내 톤 customization 용
  }
  ```
- **Output.**
  ```ts
  {
    fiveLineSummary: string;        // exact "5줄 분석" — newline-separated
    toolCallTagsExpected: string[]; // v3 footer 의 "도구 호출: ..." 표기용
    generatedAt: string;
    tokensUsed: number;
  }
  ```
- **Body.** `hostApi.callLlm(prompt, { maxTokens, systemPrompt })`. systemPrompt 는 v3 카드의 mood 와 일치 — 격식체 + 5줄 강제 + 우선순위 sort.

### 5.5 `agent_hub_decide_approval_with_host`

- **호출 source.** UI direct call only. 사용자가 "승인 요청" 카드의 항목을 클릭해 컨펌 모달이 뜨고 OK 한 시점.
- **Input.**
  ```ts
  {
    approvalId: number | string;            // backend ApprovalRequest.id
    decision: "approved" | "rejected";
    reason?: string;
  }
  ```
- **Output.**
  ```ts
  {
    bridgedDecision: ApprovalChoice;        // "allow-once" | "deny-once" — host §8 결정
    backendDecisionId?: number | string;    // host 가 allow 했을 때 backend 에 친 결과
    auditedAt: string;
    bridgeError?: { reason: "timeout"|"deny-from-host"|"send-failed"; message: string };
  }
  ```
- **Body.**
  1. plugin 이 `agent_hub_list_approvals` 로 가져온 row 의 metadata (`title`, `body`, `action_type`, `target_scope`) 를 `args` 에 채워 host §8 IPC `lvis:approval:request` 발송.
  2. host §8 ApprovalGate.requestAndWait → 사용자 OS-native 모달 → 응답 반환 (`allow-once` / `deny-once`).
  3. host 가 allow 면 plugin 이 `client.decideApproval(approvalId, decision, reason)` 호출. host 가 deny 면 backend 결정은 _건너뛰지 않고_, plugin UI 가 명시 거절 상태로 남는다 (사용자가 host 측에서 "이 결정 자체에 대한 승인" 을 거부한 것이므로).
- **No-Fallback.** host §8 가 timeout 나면 (`deny-once` 자동 반환), backend `decideApproval` 절대 호출 금지. fallback 카운터/우회 분기 금지.

### 5.6 (기존 22 tool 의 재정의 없음)

기존 tool 은 schema/semantic 모두 그대로 유지. v3 UI 가 _새 5 tool_ + _기존 일부 tool_ (`agent_hub_status`, `agent_hub_list_approvals`, `agent_hub_my_feed`, `agent_hub_post_team_channel`, `agent_hub_post_work_log`) 만 사용. 나머지는 LLM tool catalog 와 hub backend bridge 를 위해 유지.

---

## Section 6. 9 Lane × 4 Wave 실행 계획

> 각 lane: **산출물 파일 list → 의존성 → OMC 에이전트 추천 → 격리 path** 순. CRITICAL marker 3요소 (canonical 보호 / fresh-clone 명령 / `/tmp` 대안) 는 Section 8 에 통합.

### Lane 1 — Plugin 골격 (manifest + build + entry point)

**책임.** 기존 v2.1 entry (`src/ui/agent-hub-panel.ts` 1599 lines + 관련 test) 즉시 삭제 (사용자 §R5 override). v3 가 0.2.0~ 단일 SoT. manifest 변경 + tsup 단일 entry + placeholder mount + configSchemaKeys 4 신규 + RELEASING.md 0.2.0 섹션. 본 lane 은 plugin-only — host repo 미수정.

**산출물 파일.**
- `plugin.json` — Section 4 의 변경분 적용
- `package.json` — version 0.2.0, devDependency 변경 없음
- `tsup.config.ts` — entry list 에 `src/ui/agent-hub-panel-v3.tsx` 추가, format esm, target es2022
- `src/ui/agent-hub-panel-v3.tsx` — _placeholder mount export only_ (실제 React tree 는 Lane 6 가 채움). 진짜 placeholder 는 `export const mount = () => Promise.resolve({ unmount: () => {} })` 1줄 + dummy `<div>` 만. Lane 6 가 unblocked 후 본문 채움.
- `src/hostPlugin.ts` — `configSchemaKeys` 배열에 신규 4 키 추가 (No-Fallback 룰).
- `RELEASING.md` — 0.2.0 release note 초안 1 paragraph
- `tsconfig.json` — JSX 활성화 (React 17+ JSX runtime)

**의존성.** 없음 (W1 첫 lane).

**OMC 에이전트 추천.** `executor` (model=sonnet) — manifest + tsup config 는 결정적 변경. `verifier` 가 PR 후 `bun run build` + `bun test` 통과 검증.

**격리 path.** `/tmp/agent-hub/L1/lvis-plugin-agent-hub`

---

### Lane 2 — 인증 / sync (S0–S2 lifecycle)

**책임.** v3 mockup 의 S0 (플러그인 진입), S1 (외부 브라우저 로그인 대기), S2 (콜백 수신 / 소스 동기화) 3 state 의 client side 흐름. 기존 `agent_hub_auth` / `agent_hub_status` 는 충분하나, v3 는 _3 state 를 명시적으로 visualize_ 한다.

**산출물 파일.**
- `src/auth/lifecycle-machine.ts` — `S0 | S1 | S2 | S3 (signed-in)` finite state machine. transition 만 다루고 IO 없음 (testable).
- `src/auth/sync-orchestrator.ts` — S2 진입 시 `client.me()` + `msgraph_calendar_today` 1회 prefetch + `agent_hub_my_recent_logs` warmup. 결과를 store action 으로 dispatch.
- `src/__tests__/lifecycle-machine.test.ts` — vitest, transition 매트릭스 (S0→S1 on `agent_hub_auth` 호출, S1→S2 on `auth.changed` event, S2→S3 on prefetch resolve, etc.)
- `src/auth/lifecycle-types.ts` — types (`AuthLifecycleState`, `AuthLifecycleEvent`)

**의존성.** Lane 1 의 manifest 가 머지된 후 (configSchemaKeys 합병이 lifecycle store 에서 보일 수 있어야 함).

**OMC 에이전트 추천.** `executor` (sonnet) + `test-engineer` (sonnet) — FSM 은 unit test 가 본질. `architect` (opus) consult 1회 — S1↔S2 race (callback 늦게 도착 + token refresh 동시) 시나리오 설계.

**격리 path.** `/tmp/agent-hub/L2/lvis-plugin-agent-hub`

---

### Lane 3 — 마이워크 데이터 (4 tools + LLM briefing)

**책임.** Section 5 의 신규 tool 중 `agent_hub_my_work_board_v3`, `agent_hub_briefing_summarize`, `agent_hub_today_team_schedule` (자기 자신 slice) 의 handler 구현. 기존 `myWorkBoardHandler` 는 _건드리지 않고_ 새 파일 추가.

**산출물 파일.**
- `src/tools/work-board-v3.ts` — `myWorkBoardV3Handler` (기존 work-board.ts 의 함수와 _별도_ export)
- `src/tools/llm-briefing.ts` — `briefingSummarizeHandler` + 5줄 system prompt
- `src/tools/today-team-schedule.ts` — calendar-list aggregate (`teamCode === undefined` → 자기 자신, `teamCode` 명시 → 팀)
- `src/tools/weekly-gantt.ts` — `myRecentLogs` + `getMyFeed` 시계열 정규화
- `src/__tests__/work-board-v3.test.ts` — 4 tool 의 normalize 테스트, `mock: false` 보존, empty/no-team status path
- `src/__tests__/llm-briefing.test.ts` — `hostApi.callLlm` mock 으로 5줄 prompt 호출 인자 검증
- `plugin.json` — `emittedEvents` 배열에 `"agent_hub.briefing.generated"` 추가 (validate-events.mjs 의 declaration↔emission 단일-PR 강제). 필요 시 `scripts/validate-events.mjs` 의 LOCAL_ALLOWLIST 또는 `lvis-plugin-sdk` event catalog 에 등록.

**의존성.** Lane 1 머지 (manifest 의 신규 tool 선언). Lane 4 의 contract (`TeamBoardV3Result`) 와 type 만 공유 — Lane 4 implementation 미완료여도 type-only import 면 unblocked.

**OMC 에이전트 추천.** `executor` (sonnet, `model=opus` 권장 — LLM prompt 디자인 부분만). `test-engineer` (sonnet).

**격리 path.** `/tmp/agent-hub/L3/lvis-plugin-agent-hub`

---

### Lane 4 — 팀보드 데이터 (5 tools + aggregator)

**책임.** Section 5 의 `agent_hub_team_board_v3` + 팀 KPI / member counts / today schedule 전체-팀 / summary paragraph generator. ms-graph manifest 의 `pluginAccess` 화이트리스트 갱신 (`msgraph_calendar_list` 추가).

**산출물 파일.**
- `src/tools/team-board-v3.ts` — `teamBoardV3Handler` (`teamWorkBoardHandler` 와 별도)
- `src/tools/team-kpi.ts` — `aggregateTeamKpi(rows): TeamKpiResult`, `aggregateMemberCounts(rows): TeamMemberKpi[]`
- `src/tools/team-summary.ts` — `summarizeTeamWeek` — `hostApi.callLlm` 으로 paragraph 2건 (wins / risks)
- `src/__tests__/team-kpi.test.ts` — pure aggregation function tests
- `src/__tests__/team-board-v3.test.ts` — handler integration tests
- `plugin.json` — `pluginAccess.plugins[0].tools` 에 `msgraph_calendar_list`, `msgraph_calendar_update` 추가 (Lane 1 PR 와 충돌 방지 위해 Lane 4 가 _마지막에_ 머지)

**의존성.** Lane 1 머지. Lane 3 (`emittedEvents.briefing.generated`) + Lane 5 (`emittedEvents.approval.bridged`) 와 `plugin.json` 3-way race 가능 — rebase-then-merge 강제, 마지막 머지자가 manifest sweep 책임. Lane 3 의 `today-team-schedule.ts` 와 type 공유.

**OMC 에이전트 추천.** `executor` (sonnet) + `test-engineer` (sonnet).

**격리 path.** `/tmp/agent-hub/L4/lvis-plugin-agent-hub`

---

### Lane 5 — 승인 시스템 (§8 bridge + confirm modal action)

**책임.** v3 "승인 요청 카드" 의 사용자 클릭 → host §8 ApprovalGate 모달 → backend decision 의 _bridge 양 끝_ 구현. 두 repo 를 동시에 건드린다 (host + plugin).

**산출물 파일.**

_lvis-app (host repo) 측:_
- `src/permissions/agent-action-requester.ts` — `requestAgentApproval(toolName, args, reason): Promise<ApprovalChoice>` 구현. 현재 skeleton 만 존재.
- `src/preload.ts` — `window.lvisPlugin.requestAgentApproval` bridge expose (contextBridge).
- `src/plugin-preload.ts` — plugin webview 측 narrow bridge 에 `requestAgentApproval` 추가.
- `src/ipc-bridge.ts` — main process 측 `lvis:plugin-bridge:request-agent-approval` IPC handler. ApprovalGate 인스턴스 호출.
- `src/__tests__/agent-action-requester.test.ts` — vitest, ApprovalGate mock 으로 round-trip 검증.

_lvis-plugin-agent-hub 측:_
- `src/tools/decide-approval-bridge.ts` — `decideApprovalWithHostHandler` (Section 5.5).
- `src/__tests__/decide-approval-bridge.test.ts` — bridge timeout / deny-from-host / send-failed 3 path 검증.
- `src/hostPlugin.ts` — handler 등록. (Lane 1 의 manifest 에 `agent_hub_decide_approval_with_host` 가 이미 선언되어 있다는 전제.)
- `plugin.json` — `emittedEvents` 배열에 `"agent_hub.approval.bridged"` 추가. 필요 시 `scripts/validate-events.mjs` LOCAL_ALLOWLIST 또는 SDK event catalog 동기.

**의존성.** Lane 1 머지. host 측 PR 과 plugin 측 PR 은 같은 사이클에 머지 (cross-repo contract sync — `lvis-app/CLAUDE.md` 의 multi-worker discipline).

**OMC 에이전트 추천.** `architect` (opus) consult 1회 — IPC race + nonce/HMAC 재사용 검토. `executor` (sonnet) — handler 구현. `security-reviewer` (sonnet) — IPC bridge 의 sensitive-path block / DLP filter pass-through 확인.

**격리 path.** `/tmp/agent-hub/L5/lvis-plugin-agent-hub` 와 `/tmp/agent-hub/L5/lvis-app`.

---

### Lane 6 — UI 컴포넌트 (9 카드 + AppBar + ConfirmModal + S0/S2/S5)

**책임.** v3 mockup 의 모든 UI 표면. Layer 1 의 React tree 전체.

**산출물 파일.**
- `src/ui/agent-hub-panel-v3.tsx` — root mount (React.createRoot, store provider)
- `src/ui/components/AppBar.tsx` — 알약 토글 (마이워크/팀보드) + 톱니
- `src/ui/components/SettingsPanel.tsx` — 4 신규 config 의 user-facing form
- `src/ui/components/MyWorkView.tsx` — Row 1/2/3 grid container
- `src/ui/components/cards/LlmBriefingCard.tsx`
- `src/ui/components/cards/ApprovalRequestCard.tsx` — chevron + footer 거절/승인
- `src/ui/components/cards/WeeklyGanttCard.tsx`
- `src/ui/components/cards/TodayScheduleCard.tsx`
- `src/ui/components/cards/MyBoardCard.tsx`
- `src/ui/components/TeamBoardView.tsx`
- `src/ui/components/cards/TeamKpiCombo.tsx` — KPI 4 + member mini rows
- `src/ui/components/cards/TeamScheduleCard.tsx` — 참석자 avatar 스택
- `src/ui/components/cards/TeamSummaryCard.tsx`
- `src/ui/components/cards/TeamBoardListCard.tsx`
- `src/ui/components/ConfirmModal.tsx` — 승인 요청 클릭 → 모달
- `src/ui/components/states/S0LoginPrompt.tsx`
- `src/ui/components/states/S2SyncingState.tsx`
- `src/ui/components/states/S5PartialSync.tsx`
- `src/ui/styles/v3.css` — v3 mockup 의 CSS variable + 6 영역 grid + 내부 스크롤 + risk red `--red`
- `src/ui/components/__tests__/cards.test.tsx` — vitest + jsdom + react-testing-library, 각 카드 render snapshot + interaction (chevron click → modal open, refresh button → store action)

**의존성.** Lane 1 (manifest의 ui.entry) + Lane 3 + Lane 4 (data shape) + Lane 5 (confirm modal action) + Lane 7 (store).

**OMC 에이전트 추천.** `designer` (sonnet) — v3 CSS / spacing 매핑 검증. `executor` (opus 권장 — UI 9 카드 동시 작업 복잡도). `qa-tester` (sonnet) — Playwright e2e 는 Lane 9. `code-simplifier` (opus) — 카드 9개 의 prop 표면 중복 제거 검토.

**격리 path.** `/tmp/agent-hub/L6/lvis-plugin-agent-hub`

**중요 검증.** `lvis-app/CLAUDE.md` 의 "Playwright Verification (REQUIRED for app changes)" 룰 — UI/렌더러 변경은 e2e 통과 필수. Lane 9 가 e2e 책임.

---

### Lane 7 — 상태 store (Zustand)

**책임.** Layer 2 의 in-renderer 상태 store. 6 영역 partial-sync 를 위해 각 영역별 ready/loading/error state 분리. action layer 가 plugin tool 호출을 wrap.

**산출물 파일.**
- `src/ui/store/agent-hub-store.ts` — Zustand `create<>` 정의 + slice (`auth`, `myWork`, `teamBoard`, `ui`, `timestamps`)
- `src/ui/store/actions.ts` — `loadAll()`, `loadMyWork()`, `loadTeamBoard()`, `triggerBriefing()`, `decideApprovalViaHost()` — 모두 `bridge.callTool` 을 wrap
- `src/ui/store/selectors.ts` — `selectMyWorkRow1()`, `selectTeamMembersFiltered()`, etc.
- `src/ui/store/__tests__/store.test.ts` — vitest, action 시퀀스 → state diff 검증
- `src/ui/store/types.ts` — store-internal types (UI-side, _backend wire types 와 분리_)

**의존성.** Lane 3 + Lane 4 의 output type 만 (`MyWorkBoardV3Result`, `TeamBoardV3Result` 의 type-only import).

**OMC 에이전트 추천.** `executor` (sonnet). `architect` (opus) consult 1회 — 6 영역 partial-sync invariants (한 카드 fail 이 다른 카드 freeze 시키면 안 됨; loadAll 의 Promise.allSettled 패턴은 v2.1 panel 에서 이미 검증됨).

**격리 path.** `/tmp/agent-hub/L7/lvis-plugin-agent-hub`

---

### Lane 8 — Integration (host 등록 + marketplace)

**책임.** 새 plugin v0.2.0 을 host 가 인식 + marketplace catalog 에 publishable 한 형태로 정리.

**산출물 파일.**

_lvis-plugin-agent-hub 측:_
- `RELEASING.md` 갱신 — 0.2.0 changelog (UI v3, manifest 신규 4 config / 5 tool / 2 emittedEvents, host §8 bridge)
- `scripts/release-0.2.0.md` (1회용 release runbook) — git tag + bun publish + marketplace re-fetch 의 9 step

_lvis-app 측:_
- `docs/architecture/architecture.md` §10 / §10.1 갱신 — Agent Hub plugin v0.2.0 의 v3 IA 반영. 기존 §10.0 readiness status 도 update (Pilot → v3 GA 직전).
- (선택) `src/__tests__/plugin-loading.test.ts` — agent-hub 0.2.0 의 manifest snapshot 이 host AJV 통과하는지 확인. 새 tool 5건 + uiCallable 5건 + window.defaultMode 제거 path.

_lvis-marketplace 측:_
- catalog entry 의 `versions` 항목에 `0.2.0` 추가. publish manifest 의 `dependencies[].pluginId="ms-graph"` `required=true` flip 이 marketplace UI 에 노출되게 한다 (사용자가 ms-graph 안 깔았을 때 install 막힘).

**의존성.** Lane 1–7 모두 머지된 후. W4 의 마지막 lane.

**OMC 에이전트 추천.** `git-master` (sonnet) — release tag + cross-repo PR 시퀀스. `writer` (haiku) — RELEASING.md / changelog 카피. `verifier` (sonnet) — release dryrun.

**격리 path.** `/tmp/agent-hub/L8/lvis-plugin-agent-hub`, `/tmp/agent-hub/L8/lvis-app`, `/tmp/agent-hub/L8/lvis-marketplace`

---

### Lane 9 — 테스트 (vitest unit + Playwright e2e)

**책임.** unit test 는 각 lane 안에서 자체 작성. Lane 9 는 _cross-cutting_ test — e2e (host 안에서 plugin 의 v3 UI 가 제대로 mount + interaction 가능한지) 와 integration test (host §8 ↔ plugin bridge 의 끝-끝 round-trip).

**산출물 파일.**

_lvis-plugin-agent-hub 측:_
- `test/integration/host-bridge.test.ts` — 가짜 hostApi 로 simulate 한 round-trip, ms-graph mock 포함
- `test/integration/full-load.test.ts` — `loadAll` action → 6 영역 모두 ready 상태로 도달 시간 < N ms 검증

_lvis-app 측:_
- `tests/e2e/agent-hub-v3.spec.ts` — Playwright (`bunx playwright test`)
  - S0 → S2 → S3 lifecycle 전환 시각화 stable
  - 알약 토글 클릭 → 마이워크 ↔ 팀보드 view 전환
  - 승인 요청 카드의 chevron 클릭 → ConfirmModal open
  - ConfirmModal "승인" → host §8 modal 등장 (mock approval gate 로 force-allow)
  - S5 partial-sync — ms-graph 호출만 force-fail 시 6 영역 중 calendar 만 error 카드
- `tests/e2e/fixtures/agent-hub-mock-server.ts` — Agent Hub backend mock (FastAPI 흉내)
- `.github/workflows/agent-hub-v3-e2e.yml` — CI workflow (기존 ui-e2e.yml 와 분리하거나 병합)

**의존성.** Lane 6 + Lane 5 + Lane 7 모두 머지된 후.

**OMC 에이전트 추천.** `qa-tester` (sonnet) + `test-engineer` (sonnet). Playwright 시나리오 설계는 `architect` (opus) 1회 consult — 6 영역 partial-sync 의 e2e 시나리오 분기.

**격리 path.** `/tmp/agent-hub/L9/lvis-plugin-agent-hub`, `/tmp/agent-hub/L9/lvis-app`

---

## Section 7. Wave 실행 순서

### Wave 1 — Lane 1 단독 (직렬화)

- **Worker.** 1 명 (single-thread). manifest + tsup config + version bump 는 충돌 위험이 가장 큰 _기반_ 변경이므로 동시 작업하지 않는다.
- **목표 산출.** `lvis-plugin-agent-hub@0.2.0` 의 manifest 가 main 에 머지되고, `bun run build` 가 새 entry `dist/ui/agent-hub-panel-v3.js` (placeholder) 를 emit. 기존 v2.1 entry 는 _그대로 동작_.
- **검증.** Copilot review loop (lvis-project/CLAUDE.md 의 머지 가능 조건) — 0 inline 코멘트 또는 MAJOR 0 + 3 round.
- **W1 종료 조건.** plugin@0.2.0 이 host 안에서 enabled, 기존 v2.1 panel 이 여전히 정상 mount, 새 v3 panel placeholder 도 (빈 div) mount 됨.

### Wave 2 — Lane 2/3/4/7 + Lane 5 contract 정의 (4 병렬 worker)

- **Worker.** 4명 병렬.
  - Worker A: Lane 2 (인증 lifecycle FSM)
  - Worker B: Lane 3 (마이워크 4 tool)
  - Worker C: Lane 4 (팀보드 5 tool + manifest pluginAccess)
  - Worker D: Lane 7 (Zustand store skeleton + types)
- **Lane 5 contract.** _Worker D 가 Lane 5 의 type-only contract_ (`requestAgentApproval` signature) 를 store action 안에 _interface 로만_ 정의. 실제 IPC handler 는 W3 의 Lane 5 worker 가 채움.
- **목표 산출.** Domain layer (Layer 3) + State layer (Layer 2) 의 type / handler / unit test 까지 머지. UI 미구현이라 e2e 검증은 W3 까지 보류.
- **검증.** 각 lane 별 vitest unit. cross-lane type compatibility 는 Lane 7 worker 가 Lane 3 / Lane 4 의 PR draft 를 type import 로 끌어와 매일 1회 sync (lvis-app/CLAUDE.md 의 "cross-repo contract sync" 룰).
- **W2 종료 조건.** main 의 plugin repo 에서 `bun test` 가 새 unit suite 통과, 새 5 tool handler 가 plugin runtime 에 등록되어 host 가 호출 시 `mock:false` 응답 반환 (UI 가 없어도 manual 호출 가능).

### Wave 3 — Lane 6 + Lane 9 + Lane 5 마무리 (3 병렬 worker)

- **Worker.** 3명 병렬.
  - Worker E: Lane 6 (UI 컴포넌트 9개) — Lane 7 의 store 와 Lane 3 / Lane 4 의 data shape 가 W2 에서 머지된 상태
  - Worker F: Lane 5 (host §8 bridge 의 host + plugin 양 측, IPC handler 실제 구현)
  - Worker G: Lane 9 (e2e + integration test)
- **목표 산출.** 사용자가 plugin 안에서 v3 UI 를 보고, 알약 토글 / 승인 confirm modal / refresh 까지 전 흐름 수동 사용 가능.
- **검증.** Lane 9 의 Playwright e2e 가 CI 에서 green. Lane 6 의 시각적 회귀는 Playwright snapshot 으로 잡는다 (lvis-app/CLAUDE.md 의 "테마/색상/투명도 / dialog/modal / chat 흐름 변경 → e2e 필수").
- **W3 종료 조건.** v3 UI 가 dev / prod 빌드에서 모두 mount, host §8 ApprovalGate 가 plugin → renderer modal → backend decideApproval 의 끝-끝 round-trip 성공.

### Wave 4 — Lane 8 통합 + Copilot review loop

- **Worker.** 1명 (release driver).
- **목표 산출.** plugin v0.2.0 release tag, marketplace catalog publish, host architecture.md §10 update, RELEASING.md 갱신, lvis-app/TODO.md sweep (구 v2.1 IA 관련 row 정리, v3 GA 신호 표기).
- **검증.** 모든 cross-repo PR 의 Copilot review loop (lvis-project/CLAUDE.md): MAJOR 0 + 3 round 또는 0 inline. 머지 후 main green smoke test.
- **W4 종료 조건.** marketplace 에서 사용자가 agent-hub 0.2.0 install → v3 UI 정상 mount → 모든 카드 render → 승인 bridge 동작.

---

## Section 8. 격리 강제

### 8.1 Canonical 보호

> CLAUDE.md (lvis-project root) 의 "Parallel Agent Isolation (CRITICAL)" 룰을 모든 worker prompt 에 그대로 박아 넣는다.

**금지.**
- `/Users/ken/workspace/GIT/github/lvis-project/lvis-plugin-agent-hub/` 직접 쓰기
- `/Users/ken/workspace/GIT/github/lvis-project/lvis-app/` 직접 쓰기
- `/Users/ken/workspace/GIT/github/lvis-project/lvis-marketplace/` 직접 쓰기

**허용.**
- 위 디렉터리에서의 _read-only_ explore (file read, grep, ls).
- 격리 path 안에서의 fresh clone + 작업 + commit + push.

### 8.2 Fresh-clone 명령 (lane 별)

각 worker 는 작업 시작 시 다음 한 줄을 실행해 격리 작업 디렉터리를 만든다.

```bash
# Lane N 일반 케이스
mkdir -p /tmp/agent-hub/L<N> && \
  gh repo clone lvis-project/lvis-plugin-agent-hub /tmp/agent-hub/L<N>/lvis-plugin-agent-hub && \
  cd /tmp/agent-hub/L<N>/lvis-plugin-agent-hub && \
  bun install
```

cross-repo lane (Lane 5, Lane 8, Lane 9) 는 추가로:

```bash
gh repo clone lvis-project/lvis-app /tmp/agent-hub/L<N>/lvis-app
gh repo clone lvis-project/lvis-marketplace /tmp/agent-hub/L<N>/lvis-marketplace   # Lane 8 only
```

### 8.3 Worker prompt 의 CRITICAL 마커 3요소

각 lane dispatch prompt 의 첫 3줄은 이 형식으로 시작한다 (Section 10 의 W1 첫 prompt 참조).

```
[CRITICAL 1] DO NOT touch canonical checkout at
  /Users/ken/workspace/GIT/github/lvis-project/lvis-plugin-agent-hub/
  /Users/ken/workspace/GIT/github/lvis-project/lvis-app/
  /Users/ken/workspace/GIT/github/lvis-project/lvis-marketplace/
  Other autopilot/executor agents may be running concurrently and writing
  to canonical paths corrupts shared state.

[CRITICAL 2] Fresh clone path:
  gh repo clone lvis-project/lvis-plugin-agent-hub /tmp/agent-hub/L<N>/lvis-plugin-agent-hub
  cd /tmp/agent-hub/L<N>/lvis-plugin-agent-hub && bun install
  Use this path for ALL writes. Push from here. Open PR from this branch.

[CRITICAL 3] If isolation=worktree configured by framework but the worktree
  was assigned to a wrong repo (e.g. lvis-app instead of lvis-plugin-agent-hub),
  fall back to the /tmp/agent-hub/L<N>/ path above. Verify before first write
  by running `pwd` and `git remote -v`. If remote does not match
  github.com/lvis-project/lvis-plugin-agent-hub.git, ABORT and re-clone.
```

### 8.4 동시 실행 가시성

- W2 의 4 worker 는 별도 PR branch 에서 push. main 에 들어오는 순서는 머지 시점 기준 (rebase-then-merge).
- main 머지 직후 각 worker 는 자기 격리 디렉터리에서 `git pull --rebase origin main` 로 경쟁 lane 의 변경 흡수.
- W2 의 worker D (Lane 7) 는 worker B / C 의 PR _draft_ 를 매일 1회 type-only sync (`git fetch upstream && git checkout origin/lane-3-draft -- src/tools/work-board-v3.ts` 같은 부분 cherry-read).

---

## Section 9. Open Risks / Mitigations

### R1. ms-graph plugin 의 `msgraph_calendar_list` schema 가 attendees 합본을 지원하는지 미확인

- **Risk.** v3 팀보드 Row 1 의 "오늘 팀원 전체 일정" 은 calendar event 별 _attendees 배열_ 이 필요하다. ms-graph 의 `calendarClient.ts` 가 이 필드를 노출 안 할 수 있음.
- **Mitigation.** Lane 4 worker 가 작업 시작 _전_ 1시간 안에 `lvis-plugin-ms-graph/src/calendar/calendarClient.ts` read-only explore. attendees 미지원이면 ms-graph plugin 측에 PR 먼저 (cross-repo blocker). 늦어지면 Lane 4 의 W2 시작 1주일 지연.
- **Owner.** Lane 4 worker (Worker C in W2). escalation: `architect` agent.

### R2. host §8 ApprovalGate 의 IPC channel 이 plugin webview 측 preload 를 거치지 않으면 lvisPlugin bridge 미존재

- **Risk.** `plugin-ui-host.tsx` L240-251 의 `<webview preload>` 는 _첫 attach_ 에만 실행. plugin → preload bridge 에 `requestAgentApproval` 을 추가했더라도 plugin webview 가 navigation 을 일으키면 bridge 가 사라진다 (코드 주석에 명시되어 있음).
- **Mitigation.** Lane 5 가 IPC handler 를 _main process_ 의 `lvis:plugin-bridge:request-agent-approval` 로 노출 (channel name 은 `lvis:` prefix 로 contract 안정). plugin-preload.ts 는 channel call 만 wrap. plugin webview navigation 정책은 변경하지 않는다 (`plugin-shell.html` 외 navigation 금지).
- **Owner.** Lane 5 worker. `security-reviewer` consult.

### R3. plugin 진입 1회 LLM briefing 의 mount-loop polling 위험

- **Risk.** D5 결정 = "plugin 진입 시 1회". 그러나 사용자가 알약 토글로 마이워크 ↔ 팀보드 를 빠르게 왕복하면 React 의 mount/unmount 가 반복 발생 가능 → callLlm 이 분당 N 번 호출되어 비용 폭증.
- **Mitigation.** Lane 7 의 Zustand store 가 `timestamps.lastBriefingAt` 를 _persistent across mount_ 으로 가지고, `triggerBriefing()` 는 마지막 호출이 5분 이내면 cache 반환. 토글 전환은 mount 가 아니라 _conditional render_ 로 구현 (Lane 6).
- **Owner.** Lane 6 + Lane 7 worker. e2e (Lane 9) 에서 토글 50회 고속 전환 시 callLlm 호출 횟수 = 1 검증.

### R4. v3 UI 가 host viewport slot 안에서 6 영역 동시 렌더 시 webview 메모리 압박

- **Risk.** plugin-ui-host 의 webview 는 `partition: persist:plugin:<hash>` 로 분리되지만, 6 영역 + Outlook 일정 + 팀원 13 명 + LLM 결과 모두를 한 DOM 트리에 띄우면 메모리 200+MB 가능.
- **Mitigation.** Lane 6 가 `cardScrollMaxHeight` config (default 200px) 로 _내부 스크롤_ 강제 (v3 의 "scrollable · n/total" 패턴). 카드 별 가상 스크롤은 _도입하지 않음_ (v3 mockup 의 IA 의도와 어긋남). 메모리 임계점 의 e2e Lighthouse audit 는 Lane 9.
- **Owner.** Lane 6 + Lane 9 worker.

### R5. v2.1 panel 즉시 폐기 후 marketplace cache invalidate 누락 risk

- **Status.** 사용자가 v2.1 entry 즉시 삭제 권한 부여 (mockup 검증 완료, 0.2.1 deferral 무효화). v3 가 0.2.0~ 단일 SoT.
- **Risk.** marketplace 의 cached 0.1.27 manifest 를 가진 active install 이 0.2.0 publish 직후 자동 sync 안 되면, host 가 cached entry `dist/ui/agent-hub-panel.js` 로 mount 시도 → "module not found" silent fail. fallback path 가 없다 (v2.1 entry 즉시 폐기).
- **Mitigation.** Lane 8 release runbook 에 "0.2.0 publish 와 동시 marketplace cache 강제 invalidate (모든 active install 의 manifest re-fetch trigger)" 항목 필수화. host plugin loader 가 manifest version 0.1.x → 0.2.0 transition 시 entry path 변경 detect 후 force-reload 하도록 Lane 8 검증.
- **Owner.** Lane 8 worker. Lane 9 e2e 가 manifest version bump 시 entry mount 경로 reload smoke test 1건 추가.

### R6. config schema 의 `riskColorOverride` 가 빈 문자열일 때 css 변수 default 로 떨어지는 분기 = silent fallback?

- **Risk.** `riskColorOverride: ""` → CSS 의 `--red: #f78166` 가 적용. 코드 분기 로 보면 "값 없으면 default" 인데 root CLAUDE.md 는 fallback 분기 금지.
- **Mitigation.** 이 경우는 _UI 레이어 외부 입력 boundary_ (사용자 setting) 이므로 fallback 정당화 (root CLAUDE.md 룰: "외부 경계에서만 정당화"). 단 schema 의 `pattern: "^(#[0-9a-fA-F]{6})?$"` 으로 입력 검증 + `default: ""` 로 의도 명시. 코드는 `cfg.riskColorOverride || "var(--red)"` 가 아니라 `cfg.riskColorOverride === "" ? null : cfg.riskColorOverride` 로 명시.
- **Owner.** Lane 1 + Lane 6 worker.

### R7. 한 lane 의 머지가 main 을 깨뜨리면 다른 worker 의 in-flight 가 모두 차단

- **Risk.** lvis-app/CLAUDE.md 의 "Main 항상 green" 룰 위반 시 W2 의 4 worker 모두 멈춤.
- **Mitigation.** rebase-then-merge + branch protection. 머지자가 post-merge smoke (각 lane 의 `bun run build` + `bun test` + Playwright e2e 1건) 즉시 실행. 깨지면 즉시 revert PR (책임자 = 마지막 머지자).
- **Owner.** 머지자 본인 + W4 의 Lane 8 release driver 가 main green 상시 감시.

---

## Section 10. 첫 실행 명령 (W1)

> 아래 prompt 를 그대로 `/team` 또는 `executor` 에이전트에 전달. CRITICAL marker 3요소가 박혀 있어 canonical 침해 risk 가 차단된다.

```
[CRITICAL 1] DO NOT touch canonical checkouts:
  /Users/ken/workspace/GIT/github/lvis-project/lvis-plugin-agent-hub/
  /Users/ken/workspace/GIT/github/lvis-project/lvis-app/
  /Users/ken/workspace/GIT/github/lvis-project/lvis-marketplace/
  Other autopilot/executor agents may be running concurrently. Writing to
  canonical paths corrupts shared state across active sessions.

[CRITICAL 2] Fresh clone & install:
  mkdir -p /tmp/agent-hub/L1
  gh repo clone lvis-project/lvis-plugin-agent-hub \
    /tmp/agent-hub/L1/lvis-plugin-agent-hub
  cd /tmp/agent-hub/L1/lvis-plugin-agent-hub && bun install
  ALL writes go inside this directory. Push branch from here. Open PR from
  this branch against lvis-project/lvis-plugin-agent-hub main.

[CRITICAL 3] If the framework auto-assigns a worktree to the wrong repo
  (e.g. lvis-app instead of lvis-plugin-agent-hub), abort and use the
  /tmp/agent-hub/L1/ path above. Before first write, verify with:
    pwd
    git remote -v
  If remote does not contain github.com/lvis-project/lvis-plugin-agent-hub,
  STOP, re-clone, and retry.

──────────────────────────────────────────────────────────────────
Mission — Lane 1 of LVIS Agent Hub Plugin v0.2.0 (UI v3) plan.

Source of truth:
  lvis-app/docs/blueprints/agent-hub-implementation-plan.md
    (specifically Section 4 "Plugin Manifest 초안" and Section 6 "Lane 1")

Deliverables (one PR titled "feat(agent-hub): v0.2.0 manifest + build skeleton for v3 UI"):
1. plugin.json — apply Section 4 changes:
   - version: 0.1.27 → 0.2.0
   - dependencies[].required: false → true (ms-graph)
   - pluginAccess.plugins[0].tools: keep existing + DO NOT add msgraph_calendar_list
     yet (Lane 4 will add). Keep ms-graph entry as-is for now.
   - tools[]: append the 5 new tool names listed in Section 4
   - uiCallable[]: append same 5 names
   - ui[0].entry: dist/ui/agent-hub-panel.js → dist/ui/agent-hub-panel-v3.js
   - ui[0]: REMOVE the "window": { "defaultMode": "detached" } block
   - configSchema.properties: add the 4 new keys per Section 4
     (appBarToggleDefault / llmBriefingMaxTokens / cardScrollMaxHeight /
      riskColorOverride)
   - emittedEvents: DO NOT append briefing.generated or approval.bridged in
     this PR. Per scripts/validate-events.mjs (No-Fallback enforcement), every
     entry in emittedEvents must have a matching emit() call site in src/ in
     the same PR. Lane 1 has no emit() sites for these two events, so they
     are deferred:
       - agent_hub.briefing.generated → declared + emitted together in Lane 3
         (briefing-summarize handler)
       - agent_hub.approval.bridged → declared + emitted together in Lane 5
         (decide-approval-bridge handler)
2. package.json — version 0.2.0; do not change deps.
3. tsup.config.ts — entry list contains ONLY src/ui/agent-hub-panel-v3.tsx
   (the v2.1 entry is deleted per user override of plan §R5). Targets es2022
   esm. JSX automatic runtime.
4. src/ui/agent-hub-panel-v3.tsx — placeholder only:
       export const mount: import("../types.js").MountFn = async ({ root }) => {
         const div = document.createElement("div");
         div.dataset.placeholder = "agent-hub-v3";
         div.textContent = "Agent Hub v3 UI placeholder — Lane 6 will replace.";
         root.replaceChildren(div);
         return { unmount: () => root.replaceChildren() };
       };
       export default mount;
   No business logic. No tests required for this stub.
5. src/hostPlugin.ts — extend the configSchemaKeys array with the 4 new
   keys exactly as listed (No-Fallback rule: schema + merge list in same PR).
6. tsconfig.json — enable JSX automatic runtime if not already.
7. RELEASING.md — append a new section "0.2.0 (UI v3 baseline)" with one
   paragraph describing the manifest changes. Do not claim e2e or UI work
   landed; defer to Lanes 2–9.

Constraints:
- DELETE src/ui/agent-hub-panel.ts (~1599 lines mock v2.1 entry) AND
  test/agent-hub-panel.test.ts. User authorized immediate removal in 0.2.0
  (overrides plan §R5 deferral). v3 is the single SoT from 0.2.0 onwards.
  Run grep -rn "agent-hub-panel\\.ts" before commit; remaining hits in src/
  must be 0.
- Do NOT touch any src/tools/*.ts. Lanes 3 / 4 / 5 own those files.
- Do NOT touch any host repo file (lvis-app). This lane is plugin-only.
- bun run build MUST succeed. bun test MUST pass (existing suite — do not
  add new tests in this lane).
- Follow lvis-project/CLAUDE.md No-Fallback rule: schema fields and the
  hostPlugin.ts configSchemaKeys list move together in this same PR.

PR description must:
- Reference lvis-app/docs/blueprints/agent-hub-implementation-plan.md §6 Lane 1
- List the 4 new config keys with their defaults
- Note that the v2.1 entry is preserved intentionally
- Note that ms-graph manifest pluginAccess updates (msgraph_calendar_list,
  msgraph_calendar_update) will arrive in Lane 4

After PR open:
- Run the Copilot Re-request review loop per lvis-project/CLAUDE.md until
  Copilot returns 0 inline comments OR (MAJOR=0 AND 3 rounds reached).
- Do not merge if any MAJOR is open.
- After merge, run `bun run build` once in /tmp/agent-hub/L1/lvis-plugin-agent-hub
  to confirm dist/ui/agent-hub-panel-v3.js exists. If build does not produce
  it, file an immediate revert PR.

Done = PR merged + build artifact verified + RELEASING.md notes present.
```

---

## Appendix A — Cross-Repo File Touch Matrix

| Repo | Lane 1 | Lane 2 | Lane 3 | Lane 4 | Lane 5 | Lane 6 | Lane 7 | Lane 8 | Lane 9 |
|------|---|---|---|---|---|---|---|---|---|
| lvis-plugin-agent-hub | ✅ manifest, tsup, hostPlugin.ts, ui placeholder, v2.1 panel delete | ✅ src/auth/*, tests | ✅ src/tools/work-board-v3, llm-briefing, today-team-schedule, weekly-gantt, tests, plugin.json (briefing.generated) | ✅ src/tools/team-board-v3, team-kpi, team-summary, manifest pluginAccess | ✅ src/tools/decide-approval-bridge, hostPlugin.ts handler reg, plugin.json (approval.bridged) | ✅ src/ui/* (React tree) | ✅ src/ui/store/* | ✅ RELEASING.md, scripts/release-0.2.0.md | ✅ test/integration/* |
| lvis-app | — | — | — | — | ✅ permissions/agent-action-requester.ts, preload.ts, plugin-preload.ts, ipc-bridge.ts, tests | — | — | ✅ docs/architecture/architecture.md §10, tests/plugin-loading.test.ts | ✅ tests/e2e/agent-hub-v3.spec.ts, fixtures, workflow yml |
| lvis-marketplace | — | — | — | — | — | — | — | ✅ catalog 0.2.0 entry | — |

---

## Appendix B — 의존성 Graph

```
                       W1
                       ┌───────────┐
                       │ Lane 1    │
                       │ manifest  │
                       └─────┬─────┘
                             │ (merged to main)
              ┌──────────────┼──────────────┐──────────────┐
              ▼              ▼              ▼              ▼            W2 parallel
        ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐
        │ Lane 2   │  │ Lane 3   │  │ Lane 4   │  │ Lane 7        │
        │ auth FSM │  │ MyWork   │  │ Team     │  │ Zustand       │
        │          │  │ tools    │  │ tools +  │  │ store + Lane 5│
        │          │  │          │  │ manifest │  │ contract type │
        └─────┬────┘  └─────┬────┘  └─────┬────┘  └───────┬──────┘
              │             │             │               │
              └─────────────┴─────────────┴───────────────┘
                                     │
                       ┌─────────────┴─────────────┐
                       │                           │
                       ▼                           ▼          W3 parallel
                  ┌──────────┐               ┌──────────┐
                  │ Lane 6   │               │ Lane 5   │
                  │ UI tree  │               │ §8 bridge│
                  │ (React)  │               │ (host+   │
                  └─────┬────┘               │  plugin) │
                        │                    └─────┬────┘
                        │                          │
                        └────────────┬─────────────┘
                                     ▼
                                ┌──────────┐
                                │ Lane 9   │       W3 (last)
                                │ e2e+integ│
                                └─────┬────┘
                                      │
                                      ▼
                                ┌──────────┐
                                │ Lane 8   │       W4
                                │ release  │
                                │ +marketpl│
                                └──────────┘
```

---

## Appendix C — 결정 추적 (재확인용)

| 결정 | 의미 | plan 내 위치 |
|------|------|------|
| D1 | Plugin UI 호스팅 = host viewport slot, detached BrowserWindow 아님 | manifest `window.defaultMode` 제거 (Section 4, Lane 1) |
| D2 | MS Graph = lvis-plugin-ms-graph 의 method 를 HostApi callTool | Section 5.3, Lane 4 의 manifest pluginAccess 갱신 |
| D3 | Approval = host §8 ApprovalGate 와 bridge | Section 2 A3 + Section 5.5 + Lane 5 |
| D4 | 기존 lvis-plugin-agent-hub repo 활용 | Section 1.2 non-goal + 모든 lane 의 격리 path |
| D5 | LLM briefing trigger = plugin 진입 시 1회, Proactive 미연계 | Section 1.2 + Section 5.4 + R3 mitigation (5분 cache) |

---

## Appendix D — Open Questions (별도 추적)

본 plan 의 6 영역 합의 외 미결 항목은 v3 mockup 의 "v3 합의 필요 항목" 섹션 (mockup line 1289–1296) 에 정의되어 있으며, 동일 항목을 `.omc/plans/open-questions.md` 로 sync 한다. 본 implementation 은 v3 mockup 의 _현재 합의 형태_ 를 기준으로 진행 — 미결 항목 결정이 늦어지면 0.2.1 minor release 로 follow-up.

미결 항목 요약:

1. 마이워크 우측 사이드 컬럼 폭 (0.55fr) 의 compact viewport 적합성
2. 승인 요청 0건일 때 카드 숨김 vs 빈 상태
3. 팀원 mini row 의 리스크 0건 표시 정책
4. 팀 통합 대시보드 페이지네이션 방식 (›‹ vs swipe vs dot)
5. 팀 업무 요약 paragraph 길이 정책 (truncation N줄 + 더보기 vs 자유)
6. 오늘 팀원 전체 일정 카드의 attendee avatar 최대 노출 + overflow ("+N명")

---

**End of plan.**
