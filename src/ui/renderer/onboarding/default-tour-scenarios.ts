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
 * `first-boot-essentials` — the canonical first-login tour. Mirrors the
 * Onb V2 mockup step body verbatim where practical (the mockup shows
 * step 2 of 4 = "먼저 한 줄로 시작해보세요"); the other three steps are
 * the rest of the §Onb V2 storyline ① 한국어 입력 ② 도구 승인 ③ ⌘K
 * 팔레트 — extended with a closing "튜토리얼 끝" step so the tour has a
 * natural exit point.
 */
const FIRST_BOOT_ESSENTIALS: TourScenario = {
  id: "first-boot-essentials",
  title: "LVIS 첫 사용 안내",
  steps: [
    {
      anchorSelector: '[data-tour-anchor="composer-input"]',
      title: "먼저 한 줄로 시작해보세요",
      body: "아무 질문이나 자유롭게 한국어로 입력하면 LVIS 가 답합니다. 즉시 인터럽트하려면 Cmd + Enter 를 누르세요.",
      keyHint: ["⌘+Enter"],
    },
    {
      anchorSelector: '[data-tour-anchor="input-action-bar"]',
      title: "도구 사용은 사용자 승인 후",
      body: "LVIS 가 파일을 읽거나 명령을 실행할 때마다 확인 카드가 떠요. 한 번 허용/거부하면 그 결정이 세션 내내 기억됩니다.",
    },
    {
      anchorSelector: '[data-tour-anchor="command-palette-toggle"]',
      title: "Cmd + K 커맨드 팔레트",
      body: "어디서든 Cmd + K 를 누르면 명령 팔레트가 열립니다. 세션 전환, 설정, 플러그인 실행 — 모두 한 곳에서.",
      keyHint: ["⌘+K"],
    },
    {
      anchorSelector: '[data-tour-anchor="composer-input"]',
      title: "튜토리얼 완료",
      body: "이제 새 대화를 시작해 보세요. 가이드 투어는 설정 → 도움말에서 언제든 다시 열 수 있어요.",
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

const PROACTIVE_WALKTHROUGH: TourScenario = {
  id: "proactive-walkthrough",
  title: "업무 알림 둘러보기",
  steps: [
    {
      anchorSelector: '[data-tour-anchor="plugin-shell:proactive-inbox"]',
      title: "받은 메일 자동 스캔",
      body: "받은편지함에서 액션 아이템 후보를 자동으로 추출합니다. 외부로 보내지 않고 로컬에서만 분석.",
    },
    {
      anchorSelector: '[data-tour-anchor="plugin-shell:proactive-actions"]',
      title: "할 일 후보 카드",
      body: "후보별로 한 줄 요약 + '할 일 추가' 버튼이 있어요. 항상 사용자 승인 후에 LVIS 작업이 됩니다.",
    },
    {
      anchorSelector: '[data-tour-anchor="plugin-shell:proactive-rules"]',
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
 */
export const DEFAULT_TOUR_SCENARIOS: Readonly<Record<string, TourScenario>> = Object.freeze({
  [FIRST_BOOT_ESSENTIALS.id]: FIRST_BOOT_ESSENTIALS,
  [MEETING_WALKTHROUGH.id]: MEETING_WALKTHROUGH,
  [INDEXER_WALKTHROUGH.id]: INDEXER_WALKTHROUGH,
  [PROACTIVE_WALKTHROUGH.id]: PROACTIVE_WALKTHROUGH,
});

export function getTourScenario(id: string): TourScenario | undefined {
  return DEFAULT_TOUR_SCENARIOS[id];
}
