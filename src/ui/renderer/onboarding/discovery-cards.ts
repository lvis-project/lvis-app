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
}

export const DISCOVERY_CARDS: readonly DiscoveryCard[] = [
  {
    id: "meeting-summary",
    icon: "🎙️",
    title: "회의 녹음을 자동으로 요약하고 할 일 추출",
    description:
      "meeting 플러그인이 STT → 요약 → 액션 아이템 추출까지 한 번에 처리합니다.",
    tags: ["5분 시연", "한국어 STT", "로컬 저장"],
    spotlightScenarioId: "meeting-summary-tour",
  },
  {
    id: "doc-search",
    icon: "📚",
    title: "로컬 문서 인덱싱 + 자연어 검색",
    description:
      "local-indexer 가 PDF / Word / 마크다운을 인덱싱하고 자연어로 답합니다.",
    tags: ["오프라인", "한국어 RRF", "PII 마스킹"],
    spotlightScenarioId: "doc-search-tour",
  },
  {
    id: "proactive-work",
    icon: "💼",
    title: "이메일 → 할 일 자동 추출 + 알림",
    description:
      "work-proactive 가 받은편지함을 스캔해 액션 아이템 후보를 알려줍니다.",
    tags: ["오버레이", "알림", "수동 승인"],
    spotlightScenarioId: "proactive-work-tour",
  },
  {
    id: "multi-agent",
    icon: "🤖",
    title: "멀티 에이전트 오케스트레이션",
    description:
      "여러 에이전트가 작업을 분산해 처리하고 결과를 다시 합성합니다.",
    tags: ["병렬", "비용 가시화", "감사"],
    spotlightScenarioId: "multi-agent-tour",
  },
  {
    id: "chat-basics",
    icon: "💬",
    title: "한국어 자연 대화 + 도구 승인 + ⌘K 팔레트",
    description:
      "기본 채팅 + 도구 승인 + Command Palette 로 LVIS 의 모든 기능을 호출합니다.",
    tags: ["⌘K", "도구 승인", "한국어"],
    spotlightScenarioId: "first-boot-essentials",
  },
] as const;

export function resolveScenarioId(card: DiscoveryCard | undefined): string {
  if (!card) return FALLBACK_SCENARIO_ID;
  return card.spotlightScenarioId || FALLBACK_SCENARIO_ID;
}
