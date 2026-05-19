/**
 * Tutorial-D — Discovery Swipe scenario card catalog.
 *
 * Each card represents a high-level LVIS scenario the user can either
 * try (swipe right → liked) or dismiss (swipe left → disliked). The
 * catalog is intentionally short (5 cards) so the 460×840 LVIS narrow
 * window fits the entire stack without scrolling.
 *
 * The `spotlightScenarioId` value is the id Tutorial-C's `tour.start`
 * channel recognises (see `src/ui/renderer/onboarding/default-tour-scenarios.ts`).
 * Cards whose scenario has not been authored yet point at
 * `first-boot-essentials` — Tutorial-C's canonical first-login tour and
 * the SpotlightTour baseline scenario.
 */

export const FALLBACK_SCENARIO_ID = "first-boot-essentials";

export interface DiscoveryCard {
  /** Stable id used for liked/disliked persistence. */
  id: string;
  /** Single-codepoint emoji rendered in the gradient hero of each card. */
  icon: string;
  /** Korean headline (max ~30 chars to fit the 460-wide card body). */
  title: string;
  /** Korean body copy — 1 short sentence, max ~80 chars. */
  description: string;
  /** Short tag pills under the body. Keep ≤ 4 entries for layout. */
  tags: readonly string[];
  /** PR-C Spotlight tour id. Falls back to `welcome-tour` when missing. */
  spotlightScenarioId: string;
  /**
   * Tutorial-X2 — plugin id this card represents, if any. When set, a "✓
   * 시도해볼래요" swipe triggers a real PluginInstallDialog confirmation
   * via the host's marketplace install path. `null` means the card is
   * meta (chat basics / multi-agent etc.) and only schedules a tour.
   *
   * The id matches the marketplace catalog slug (e.g. `lvis-plugin-meeting`)
   * so the dialog can look up the package by id without a second probe.
   */
  pluginId: string | null;
  /**
   * U7 — Per-card scenario preview. Mini step list shown on the active
   * card so the user understands what the tour will demonstrate BEFORE
   * pressing "실행하기 →". Keep each step ≤ 18 chars to fit the 460-wide
   * card body without wrapping.
   */
  previewSteps: readonly string[];
}

export const DISCOVERY_CARDS: readonly DiscoveryCard[] = [
  {
    id: "meeting-summary",
    icon: "🎙️",
    title: "회의 녹음을 자동으로 요약하고 할 일 추출",
    description:
      "meeting 플러그인이 STT → 요약 → 액션 아이템 추출까지 한 번에 처리합니다.",
    tags: ["5분 시연", "한국어 STT", "로컬 저장"],
    spotlightScenarioId: "meeting-walkthrough",
    pluginId: "lvis-plugin-meeting",
    previewSteps: [
      "회의 시작 버튼",
      "자동 STT 진행",
      "요약 + 할 일 생성",
      "메모리에 저장",
    ],
  },
  {
    id: "doc-search",
    icon: "📚",
    title: "로컬 문서 인덱싱 + 자연어 검색",
    description:
      "local-indexer 가 PDF / Word / 마크다운을 인덱싱하고 자연어로 답합니다.",
    tags: ["오프라인", "한국어 RRF", "PII 마스킹"],
    spotlightScenarioId: "indexer-walkthrough",
    pluginId: "lvis-plugin-local-indexer",
    previewSteps: [
      "폴더 선택",
      "백그라운드 인덱싱",
      "자연어 질문",
      "출처 표시 답변",
    ],
  },
  {
    id: "proactive-work",
    icon: "💼",
    title: "이메일 → 할 일 자동 추출 + 알림",
    description:
      "work-proactive 가 받은편지함을 스캔해 액션 아이템 후보를 알려줍니다.",
    tags: ["오버레이", "알림", "수동 승인"],
    spotlightScenarioId: "proactive-walkthrough",
    pluginId: "lvis-plugin-work-proactive",
    previewSteps: [
      "이메일 연결",
      "스캔 + 후보 추출",
      "오버레이 알림",
      "수동 승인 또는 무시",
    ],
  },
  {
    id: "multi-agent",
    icon: "🤖",
    title: "멀티 에이전트 오케스트레이션",
    description:
      "여러 에이전트가 작업을 분산해 처리하고 결과를 다시 합성합니다.",
    tags: ["병렬", "비용 가시화", "감사"],
    spotlightScenarioId: "multi-agent-tour",
    pluginId: "lvis-plugin-agent-hub",
    previewSteps: [
      "에이전트 선택",
      "작업 dispatch",
      "병렬 진행 모니터",
      "결과 합성",
    ],
  },
  {
    id: "chat-basics",
    icon: "💬",
    title: "한국어 자연 대화 + 도구 승인 + ⌘K 팔레트",
    description:
      "기본 채팅 + 도구 승인 + Command Palette 로 LVIS 의 모든 기능을 호출합니다.",
    tags: ["⌘K", "도구 승인", "한국어"],
    spotlightScenarioId: "first-boot-essentials",
    pluginId: null,
    previewSteps: [
      "한 줄 입력",
      "도구 승인 모달",
      "⌘K 명령 팔레트",
      "⌘? 도움말",
    ],
  },
] as const;

export function resolveScenarioId(card: DiscoveryCard | undefined): string {
  if (!card) return FALLBACK_SCENARIO_ID;
  return card.spotlightScenarioId || FALLBACK_SCENARIO_ID;
}
