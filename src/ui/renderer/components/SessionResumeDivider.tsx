/**
 * SessionResumeDivider — emerald-toned horizontal-line divider placed at the
 * head of a resumed child session's entry list when the parent session left
 * a rolling summary preamble (§457 PR-A). Restored from the deleted
 * StackedChatView (issue #547 visual absorption).
 *
 * We deliberately do NOT show the preamble text — that material lives in the
 * system prompt and surfacing it inline would leak summarization content into
 * a chat surface where the user reads turn-by-turn dialog. The disclosure
 * mirrors what the LLM sees ("이전 대화 요약 N자 적용") without revealing the
 * actual summary.
 */
export function SessionResumeDivider({ preambleChars }: { preambleChars: number }) {
  return (
    <div
      data-testid="session-resume-divider"
      className="flex items-center gap-2 py-2 my-2"
    >
      <span className="h-px flex-1 bg-emerald-500/30" />
      <span className="text-[10px] text-emerald-400/75 font-medium">
        ↩ 이전 대화 이어서 시작 (요약 {preambleChars}자 적용)
      </span>
      <span className="h-px flex-1 bg-emerald-500/30" />
    </div>
  );
}
