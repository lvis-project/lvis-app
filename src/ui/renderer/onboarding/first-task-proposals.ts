/**
 * Tutorial-X5 — Post-tour First Task Proposal catalog.
 *
 * After the SpotlightTour finishes, we want to bridge the user from
 * "I just saw a tutorial" → "I just achieved my first real value with
 * LVIS" without a dead-end transition. This module is the catalog of
 * first-task proposals keyed by *installed plugin id* — the
 * PostTourFirstTask component looks up the user's installed plugins
 * and surfaces the highest-priority proposal whose plugin is present.
 *
 * Each proposal has:
 *   - `pluginId` (matches the marketplace slug)
 *   - `priority` (lower number wins — the order of "real first value")
 *   - `headlineKo` (the offer card title)
 *   - `bodyKo` (1–2 sentence description)
 *   - `ctaKo` (button label)
 *   - `composerSeed` (the message text that auto-fills the composer when
 *     the user accepts — this is what triggers the *real* plugin tool
 *     via the natural conversation path, no hidden IPC)
 *
 * Design rationale:
 *   - Pre-seeding the composer (instead of dispatching a hidden tool
 *     call) keeps the user in control and matches LVIS's tool-approval
 *     contract. The user sees the prompt that will run.
 *   - The catalog is plugin-keyed (not card-keyed) so it works for any
 *     installation source — Discovery Swipe ✓, Memory Seed chip click,
 *     or direct marketplace install all converge on the same proposal.
 */

export interface FirstTaskProposal {
  pluginId: string;
  priority: number;
  headlineKo: string;
  bodyKo: string;
  ctaKo: string;
  /**
   * Composer pre-fill text. The PostTourFirstTask card dispatches this
   * via `api.chatSubmit?.(composerSeed)` (or a composer-set IPC) so the
   * user is *one click* away from a real plugin invocation — every step
   * after is the canonical chat-tool-approval loop, not a tutorial fork.
   */
  composerSeed: string;
}

export const FIRST_TASK_PROPOSALS: readonly FirstTaskProposal[] = [
  {
    pluginId: "lvis-plugin-meeting",
    priority: 10,
    headlineKo: "지금 회의를 녹음해볼까요?",
    bodyKo:
      "지금 시작 버튼을 누르면 LVIS 가 STT → 요약 → 액션 아이템까지 자동으로 처리합니다.",
    ctaKo: "회의 녹음 시작",
    composerSeed: "지금 회의 녹음을 시작해줘",
  },
  {
    pluginId: "lvis-plugin-local-indexer",
    priority: 20,
    headlineKo: "인덱싱할 폴더를 골라볼까요?",
    bodyKo:
      "자주 보는 문서 폴더를 한 번만 알려주면 자연어로 바로 검색할 수 있게 됩니다.",
    ctaKo: "폴더 선택",
    composerSeed: "인덱싱할 문서 폴더를 추가해줘",
  },
  {
    pluginId: "lvis-plugin-work-proactive",
    priority: 30,
    headlineKo: "오늘 처리할 일을 정리해드릴까요?",
    bodyKo:
      "받은편지함을 스캔해 액션 아이템 후보를 정리합니다. 모든 결과는 사용자 승인 후에만 LVIS 작업이 됩니다.",
    ctaKo: "받은 메일 정리",
    composerSeed: "오늘 처리할 일을 정리해줘",
  },
  {
    pluginId: "lvis-plugin-agent-hub",
    priority: 40,
    headlineKo: "첫 멀티 에이전트 작업을 시도해볼까요?",
    bodyKo:
      "여러 에이전트가 동시에 작업을 분산 처리하고 결과를 합성합니다. 비용·시간이 사전에 표시됩니다.",
    ctaKo: "에이전트 작업 시도",
    composerSeed: "새 기능 spec 을 보고 PRD, 일정, 리스크 분석을 동시에 만들어줘",
  },
] as const;

/**
 * Pick the highest-priority proposal whose plugin is installed. Returns
 * `null` when no installed plugin has a registered proposal — the
 * PostTourFirstTask card then doesn't render and the user lands on the
 * normal chat surface (already a valid end state).
 */
export function pickFirstTaskProposal(
  installedPluginIds: readonly string[],
): FirstTaskProposal | null {
  const installedSet = new Set(installedPluginIds);
  const candidates = FIRST_TASK_PROPOSALS.filter((p) =>
    installedSet.has(p.pluginId),
  );
  if (candidates.length === 0) return null;
  // Sort by priority ascending — lowest number is the user's first
  // recommended action.
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0];
}
