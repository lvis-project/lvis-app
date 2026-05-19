/**
 * Tutorial-C — default Spotlight tour scenarios.
 *
 * A "scenario" is a sequence of `TourStep` cards rendered by the
 * `SpotlightTour` component. The Onb V2 mockup (`/tmp/login-lvis/index.html`,
 * "Onb V2 — Spotlight (toggle B)") demonstrates the visual contract:
 *   - The viewport is darkened by a 78% black overlay.
 *   - One target element (`anchorSelector`) is "spotlit" via a violet ring
 *     + glow drawn around its bounding rect.
 *   - A floating card sits anchored to the target, containing a step badge
 *     (`step / total`), title, body copy, dot pagination, a
 *     "건너뛰기" (skip) action, and a "다음 →" (next) action.
 *
 * Step-ordering rules (mockup §"Onb V2"):
 *   1. The first scenario MUST be `first-boot-essentials` — surfaces the
 *      three things a new LVIS user has to know before they can be
 *      productive: free-form Korean input, approval gating, and the
 *      ⌘K command palette.
 *   2. Each step pins to a stable DOM `data-tour-anchor` attribute so
 *      renderer refactors don't silently break the tour. Anchors live on
 *      the Composer textarea, the InputActionBar action chip cluster, and
 *      the command palette toggle.
 *   3. `body` is plain text — the component renders kbd hints out-of-band
 *      via `keyHint` so a screen-reader can announce "Cmd plus K" rather
 *      than reading the literal kbd glyph string.
 *
 * The scenarios live in the renderer (not in the host) because they only
 * reference renderer DOM anchors; the host has no business knowing the
 * shape of the Composer toolbar. The host-side `~/.lvis/onboarding/`
 * store only persists scenario *ids* — it does not see step bodies, which
 * keeps the storage namespace minimal.
 */

/**
 * U8 — Auto-advance trigger declaration. When a step declares a
 * `completionTrigger`, the SpotlightTour attaches a listener for the
 * matching DOM event and advances to the next step the moment the user
 * performs the action. Without a trigger the user must click "다음 →"
 * manually.
 *
 * Variants:
 *   - { kind: "keypress"; combo: "⌘+K" }   — global hotkey detection.
 *   - { kind: "input"; selector }          — typing in the matching element.
 *   - { kind: "click"; selector }          — clicking the matching element.
 *   - { kind: "manual" }                   — explicit "다음 →" only (default).
 */
export type CompletionTrigger =
  | { kind: "keypress"; combo: "⌘+K" | "⌘+?" | "⌘+Enter" }
  | { kind: "input"; selector: string }
  | { kind: "click"; selector: string }
  | { kind: "manual" };

export interface TourStep {
  /**
   * Stable CSS selector pinned to a `data-tour-anchor="…"` attribute on
   * the target DOM node. Selectors that match >1 element use the first
   * hit; if no element matches, the component falls back to centring the
   * card in the viewport so the tour never gets stuck (mockup contract
   * "tour must not block the chat surface").
   */
  anchorSelector: string;
  /** Short heading, displayed above the body copy. */
  title: string;
  /** Plain-text explanation. Do NOT include HTML / kbd glyphs here. */
  body: string;
  /**
   * Optional keyboard-shortcut hint rendered as `<kbd>` chips beside the
   * body. Each entry is a human-readable label (e.g. `"⌘+K"`, `"⌘+Enter"`).
   * The component renders these as <kbd> elements with an `aria-label` of
   * `"shortcut: <label>"` so screen-readers announce them properly.
   */
  keyHint?: string[];
  /**
   * U8 — Interactive auto-advance trigger. When omitted or `kind: "manual"`,
   * the user must click "다음 →" to proceed. With any other variant the
   * tour advances automatically the moment the user performs the
   * declared action (e.g. types in the composer, presses ⌘+K, clicks a
   * button). The user can still skip via "다음 →" if they prefer.
   */
  completionTrigger?: CompletionTrigger;
}

export interface TourScenario {
  /** Stable id persisted in `~/.lvis/onboarding/tour-state.json`. */
  id: string;
  /** Display title shown in the dot-pagination row (`step / total`). */
  title: string;
  /** Ordered steps. Must be non-empty. */
  steps: TourStep[];
}

/**
 * `first-boot-essentials` — the canonical first-login tour.
 *
 * Z onboarding chain extension (2026-05-19): the tour grew from 4 → 7
 * steps so the user lands with a full mental model of the host UI
 * before plugins are introduced. New steps cover the help-shortcut hint
 * (4), recent chat history (5), the Settings/menu entry (6), and the
 * vendor/model status-bar indicator (7). A follow-up 8th step (2026-05-19)
 * introduces the plugin grid entry so the user discovers the plugin
 * surface during the first-boot tour rather than stumbling on it
 * later. Each anchor is pinned to a `data-tour-anchor=` attribute on a
 * production DOM element so renderer refactors break the tour visibly
 * (test in `__tests__/tour-anchors-trigger.test.tsx`).
 */
const FIRST_BOOT_ESSENTIALS: TourScenario = {
  id: "first-boot-essentials",
  title: "LVIS 첫 사용 안내",
  steps: [
    {
      anchorSelector: '[data-tour-anchor="composer-input"]',
      title: "1단계 · 한국어로 자유롭게 입력",
      body: "이 텍스트 박스가 LVIS 와 대화하는 시작점입니다. 한국어로 자유롭게 입력하면 LVIS 가 답하고, 진행 중인 답을 멈추려면 ⌘+Enter 를 누르세요. 지금 한 줄 적어보세요 — 입력이 감지되면 다음 단계로 자동 이동합니다.",
      keyHint: ["⌘+Enter"],
      completionTrigger: {
        kind: "input",
        selector: '[data-tour-anchor="composer-input"]',
      },
    },
    {
      anchorSelector: '[data-tour-anchor="input-action-bar"]',
      title: "2단계 · 도구는 항상 사용자 승인",
      body: "LVIS 가 파일을 읽거나 명령을 실행할 때마다 승인 카드가 이 영역에 표시됩니다. 한 번 허용/거부하면 그 결정이 현재 세션에 기억되어 같은 도구는 다시 묻지 않습니다.",
      completionTrigger: { kind: "manual" },
    },
    {
      anchorSelector: '[data-tour-anchor="command-palette-toggle"]',
      title: "3단계 · ⌘+K 명령 팔레트",
      body: "어디서든 ⌘+K 를 눌러 명령 팔레트를 여세요. 세션 전환, 설정, 플러그인 실행 — 모두 한 곳에서. 지금 한 번 눌러 보면 다음 단계로 자동 이동합니다.",
      keyHint: ["⌘+K"],
      completionTrigger: { kind: "keypress", combo: "⌘+K" },
    },
    {
      anchorSelector: '[data-tour-anchor="help-shortcut-hint"]',
      title: "4단계 · ⌘+? 도움말 단축키",
      body: "이 가이드는 언제든 ⌘+? 로 다시 열 수 있어요. 상단 우측의 ⌘+? 칩이 항상 같은 자리에 있어 길을 잃지 않습니다.",
      keyHint: ["⌘+?"],
      completionTrigger: { kind: "manual" },
    },
    {
      anchorSelector: '[data-tour-anchor="chat-history"]',
      title: "5단계 · 최근 대화와 즐겨찾기",
      body: "검색 아이콘을 누르면 최근 대화 / 즐겨찾기 / 본문 검색이 한 번에 열립니다. 단축키 ⌘+F 로도 같은 패널이 뜹니다.",
      keyHint: ["⌘+F"],
      completionTrigger: { kind: "manual" },
    },
    {
      anchorSelector: '[data-tour-anchor="settings-entry"]',
      title: "6단계 · 설정 · 루틴 · 메모리",
      body: "이 햄버거 메뉴 안에 설정, 루틴, 메모리, 내보내기가 모여 있어요. 모델 변경이나 권한 조정도 여기서 시작합니다.",
      completionTrigger: { kind: "manual" },
    },
    {
      anchorSelector: '[data-tour-anchor="status-bar-vendor"]',
      title: "7단계 · 활성 LLM 벤더 · 모델",
      body: "하단 상태바는 지금 사용 중인 벤더와 모델을 항상 표시합니다. 클릭하면 곧바로 설정 → LLM 으로 이동해요.",
      completionTrigger: { kind: "manual" },
    },
    {
      anchorSelector: '[data-tour-anchor="plugin-entry"]',
      title: "8단계 · 플러그인 — 회의·문서·업무 도우미",
      body: "여기서 플러그인을 설치하고 사용할 수 있어요. 회의 녹음·요약, 로컬 문서 검색, 받은편지함 → 할 일 자동화 등 LVIS 기능을 그리드 안에서 확장합니다. 끝에 있는 '마켓' 셀로 새 플러그인을 추가할 수 있어요.",
      completionTrigger: { kind: "manual" },
    },
  ],
};

/**
 * U7 — Per-card scenario tours. Each Discovery Swipe card's
 * "실행하기 →" CTA dispatches into one of these (or the fallback
 * `first-boot-essentials` when the plugin-specific anchors are not
 * mounted yet). Plugin-specific anchors live in the owning plugin
 * package; when the plugin is not installed, `readRect` returns null
 * and the SpotlightTour centres the card so the user still sees the
 * narrative.
 */
const MEETING_SUMMARY_TOUR: TourScenario = {
  id: "meeting-summary-tour",
  title: "회의 자동 요약 가이드",
  steps: [
    {
      anchorSelector: '[data-tour-anchor="meeting-start"]',
      title: "1단계 · 회의 시작",
      body: "회의 플러그인의 시작 버튼을 눌러 녹음을 시작합니다. (플러그인이 설치되어 있지 않으면 마켓플레이스에서 'meeting' 을 먼저 설치하세요.)",
    },
    {
      anchorSelector: '[data-tour-anchor="meeting-stop"]',
      title: "2단계 · 자동 STT 진행",
      body: "회의가 진행되는 동안 청크 단위로 음성을 텍스트로 변환합니다. 정지 버튼을 누르면 STT 결과가 모두 누적되어 표시됩니다.",
    },
    {
      anchorSelector: '[data-tour-anchor="meeting-summary-panel"]',
      title: "3단계 · 요약과 할 일 추출",
      body: "정지 후 LVIS 가 회의 내용을 요약하고 액션 아이템을 추출합니다. 결과는 ~/.lvis/plugins/meeting/ 로 저장되어 다음 세션에서 다시 열 수 있습니다.",
    },
    {
      anchorSelector: '[data-tour-anchor="composer-input"]',
      title: "4단계 · 회의 결과 활용",
      body: "추출된 액션 아이템을 챗 입력창에 붙여넣어 후속 작업을 LVIS 에게 시킬 수 있어요. 가이드는 ⌘+? 로 다시 열 수 있습니다.",
      keyHint: ["⌘+?"],
    },
  ],
};

const DOC_SEARCH_TOUR: TourScenario = {
  id: "doc-search-tour",
  title: "로컬 문서 검색 가이드",
  steps: [
    {
      anchorSelector: '[data-tour-anchor="indexer-folder-picker"]',
      title: "1단계 · 인덱싱 폴더 선택",
      body: "local-indexer 플러그인의 폴더 선택 버튼을 눌러 인덱싱할 디렉토리를 지정하세요. PDF / Word / 마크다운 / 코드 파일이 자동 감지됩니다.",
    },
    {
      anchorSelector: '[data-tour-anchor="indexer-progress"]',
      title: "2단계 · 백그라운드 인덱싱",
      body: "선택한 폴더가 백그라운드에서 청크 단위로 인덱싱됩니다. 진행률 표시기가 100% 가 되면 검색 준비가 끝납니다.",
    },
    {
      anchorSelector: '[data-tour-anchor="composer-input"]',
      title: "3단계 · 자연어로 질문",
      body: "챗 입력창에 자연어로 질문하면 인덱싱된 문서에서 답을 찾아 출처와 함께 표시합니다. 예) '지난 분기 마케팅 보고서 요약해줘'",
    },
    {
      anchorSelector: '[data-tour-anchor="composer-input"]',
      title: "4단계 · 가이드 완료",
      body: "이제 자유롭게 질문해 보세요. 인덱싱 폴더는 설정 → 플러그인에서 언제든 추가/삭제할 수 있습니다.",
      keyHint: ["⌘+?"],
    },
  ],
};

const WORK_ASSISTANT_TOUR: TourScenario = {
  // Renamed from `proactive-work-tour` to align with the canonical
  // 업무 도우미 brand. Plugin tour-anchors live in lvis-plugin-work-proactive
  // (package repo) and use the manifest id (work-assistant) on their DOM
  // attributes — the test/e2e fixture pins `manifest.id="work-assistant"`.
  id: "work-assistant-tour",
  title: "이메일 → 할 일 가이드",
  steps: [
    {
      anchorSelector: '[data-tour-anchor="work-assistant-connect"]',
      title: "1단계 · 이메일 계정 연결",
      body: "업무 도우미 플러그인에서 이메일 계정 (MS Graph 등) 을 연결합니다. 인증은 시스템 브라우저에서 진행돼요.",
    },
    {
      anchorSelector: '[data-tour-anchor="work-assistant-scan"]',
      title: "2단계 · 받은편지함 스캔",
      body: "주기적으로 받은편지함을 스캔해 액션 아이템 후보를 추출합니다. 모든 후보는 오버레이 카드로 표시되어 사용자가 검토할 수 있습니다.",
    },
    {
      anchorSelector: '[data-tour-anchor="work-assistant-overlay"]',
      title: "3단계 · 후보 승인 또는 무시",
      body: "오버레이 카드에서 '✓ 채택' 을 누르면 LVIS 가 후속 작업을 자동 시작합니다. 무시하면 후보는 사라지고 audit 로그에 기록됩니다.",
    },
    {
      anchorSelector: '[data-tour-anchor="composer-input"]',
      title: "4단계 · 가이드 완료",
      body: "이메일 스캔 주기는 설정 → 플러그인 → 업무 도우미에서 조정할 수 있어요.",
      keyHint: ["⌘+?"],
    },
  ],
};

const MULTI_AGENT_TOUR: TourScenario = {
  id: "multi-agent-tour",
  title: "멀티 에이전트 가이드",
  steps: [
    {
      anchorSelector: '[data-tour-anchor="agent-hub-list"]',
      title: "1단계 · 에이전트 선택",
      body: "agent-hub 플러그인에서 사용할 에이전트를 선택합니다. 각 에이전트는 다른 LLM / 다른 도구 권한을 가질 수 있어요.",
    },
    {
      anchorSelector: '[data-tour-anchor="agent-hub-dispatch"]',
      title: "2단계 · 작업 dispatch",
      body: "선택한 에이전트들에게 작업을 dispatch 하면 각자 독립적으로 진행합니다. 토큰 / 비용은 실시간으로 추적됩니다.",
    },
    {
      anchorSelector: '[data-tour-anchor="agent-hub-monitor"]',
      title: "3단계 · 병렬 진행 모니터",
      body: "에이전트들의 진행 상태가 한 화면에 표시됩니다. 특정 에이전트의 결과를 클릭하면 상세 세션으로 이동할 수 있습니다.",
    },
    {
      anchorSelector: '[data-tour-anchor="composer-input"]',
      title: "4단계 · 가이드 완료",
      body: "에이전트별 권한 / 비용 한도는 설정 → 권한 / 에이전트 탭에서 세밀하게 조정할 수 있습니다.",
      keyHint: ["⌘+?"],
    },
  ],
};

/**
 * Tutorial-X3 — per-plugin walkthrough scenarios. Each scenario spotlights
 * the *real* DOM anchors a plugin shell exposes (data-tour-anchor) so the
 * user sees the plugin's UI rather than a generic placeholder. Anchors
 * use `[data-tour-anchor="plugin-shell:<id>"]` so the plugin webview
 * shell can declare them once and every scenario reuses the selector.
 *
 * The 4th step in each scenario points at the composer so the tour ends
 * with the user back on the chat surface — preventing the user from
 * being stranded inside a plugin UI without a path back to chat.
 */
const MEETING_WALKTHROUGH: TourScenario = {
  id: "meeting-walkthrough",
  title: "회의 플러그인 둘러보기",
  steps: [
    {
      anchorSelector: '[data-tour-anchor="plugin-shell:meeting-record"]',
      title: "원클릭 회의 녹음",
      body: "이 버튼으로 회의 녹음을 시작합니다. STT 와 요약이 자동으로 이어집니다.",
    },
    {
      anchorSelector: '[data-tour-anchor="plugin-shell:meeting-history"]',
      title: "지난 회의 기록",
      body: "이전 회의의 요약·액션 아이템·원문 STT 가 로컬에 저장됩니다.",
    },
    {
      anchorSelector: '[data-tour-anchor="plugin-shell:meeting-actions"]',
      title: "추출된 할 일",
      body: "회의에서 자동 추출된 액션 아이템을 ⌘K → '할 일' 에서 바로 등록할 수 있어요.",
    },
    {
      anchorSelector: '[data-tour-anchor="composer-input"]',
      title: "회의 후 자연스러운 후속 대화",
      body: '"이번 회의 요약 보여줘" 같은 자연어로 회의 결과를 다시 불러올 수 있어요.',
    },
  ],
};

const INDEXER_WALKTHROUGH: TourScenario = {
  id: "indexer-walkthrough",
  title: "로컬 인덱서 둘러보기",
  steps: [
    {
      anchorSelector: '[data-tour-anchor="plugin-shell:indexer-add-folder"]',
      title: "인덱스할 폴더 추가",
      body: "PDF / Word / Markdown 폴더를 추가하면 로컬에서 임베딩이 만들어집니다. 외부 서버로 문서가 전송되지 않습니다.",
    },
    {
      anchorSelector: '[data-tour-anchor="plugin-shell:indexer-status"]',
      title: "인덱싱 진행 상태",
      body: "파일 수, PII 마스킹 결과, 마지막 동기화 시각을 확인할 수 있어요.",
    },
    {
      anchorSelector: '[data-tour-anchor="plugin-shell:indexer-search"]',
      title: "자연어 검색",
      body: '"Q2 보안 정책" 같은 자연어를 입력하면 한국어 RRF 가 가장 관련성 높은 문단을 찾아옵니다.',
    },
    {
      anchorSelector: '[data-tour-anchor="composer-input"]',
      title: "채팅과 함께 사용",
      body: "채팅에서 직접 '문서 검색해줘' 라고 말해도 인덱서가 답변에 결합됩니다.",
    },
  ],
};

const WORK_ASSISTANT_WALKTHROUGH: TourScenario = {
  // Renamed from `proactive-walkthrough`. Discovery card
  // `work-assistant.spotlightScenarioId` dispatches into this scenario id.
  id: "work-assistant-walkthrough",
  title: "업무 도우미 둘러보기",
  steps: [
    {
      anchorSelector: '[data-tour-anchor="plugin-shell:work-assistant-inbox"]',
      title: "받은 메일 자동 스캔",
      body: "받은편지함에서 액션 아이템 후보를 자동으로 추출합니다. 외부로 보내지 않고 로컬에서만 분석.",
    },
    {
      anchorSelector: '[data-tour-anchor="plugin-shell:work-assistant-actions"]',
      title: "할 일 후보 카드",
      body: "후보별로 한 줄 요약 + '할 일 추가' 버튼이 있어요. 항상 사용자 승인 후에 LVIS 작업이 됩니다.",
    },
    {
      anchorSelector: '[data-tour-anchor="plugin-shell:work-assistant-rules"]',
      title: "규칙 편집",
      body: "어떤 발신자/키워드를 우선 처리할지 직접 정합니다. 변경은 즉시 반영.",
    },
    {
      anchorSelector: '[data-tour-anchor="composer-input"]',
      title: "후속 채팅",
      body: '"오늘 우선 처리할 할 일" 같은 자연어로 후보 목록을 다시 볼 수 있어요.',
    },
  ],
};

/**
 * Registry — `SpotlightTour` consumes this map to resolve `scenarioId`
 * payloads received over `lvis:tour:start`. New scenarios are added here;
 * the host-side store is unaware of the contents.
 *
 * U7 — Per-card tours dispatched from the Discovery Swipe "실행하기 →"
 * CTA. Plugin-specific tours degrade gracefully when the owning plugin
 * is not installed: `readRect` returns null for the missing anchor and
 * `SpotlightTour.cardPlacement` centres the step card so the narrative
 * is still legible.
 */
export const DEFAULT_TOUR_SCENARIOS: Readonly<Record<string, TourScenario>> = Object.freeze({
  [FIRST_BOOT_ESSENTIALS.id]: FIRST_BOOT_ESSENTIALS,
  [MEETING_WALKTHROUGH.id]: MEETING_WALKTHROUGH,
  [INDEXER_WALKTHROUGH.id]: INDEXER_WALKTHROUGH,
  [WORK_ASSISTANT_WALKTHROUGH.id]: WORK_ASSISTANT_WALKTHROUGH,
  [MEETING_SUMMARY_TOUR.id]: MEETING_SUMMARY_TOUR,
  [DOC_SEARCH_TOUR.id]: DOC_SEARCH_TOUR,
  [WORK_ASSISTANT_TOUR.id]: WORK_ASSISTANT_TOUR,
  [MULTI_AGENT_TOUR.id]: MULTI_AGENT_TOUR,
});

export function getTourScenario(id: string): TourScenario | undefined {
  return DEFAULT_TOUR_SCENARIOS[id];
}
