import { useTranslation } from "../../../i18n/react.js";

/**
 * SessionResumeDivider — emerald-toned horizontal-line divider placed at the
 * head of a resumed child session's entry list when the parent session left
 * a rolling summary preamble.
 *
 * We deliberately do NOT show the preamble text — that material lives in the
 * system prompt and surfacing it inline would leak summarization content into
 * a chat surface where the user reads turn-by-turn dialog. The disclosure
 * mirrors what the LLM sees ("이전 대화 요약 N자 적용") without revealing the
 * actual summary.
 */
export function SessionResumeDivider({ preambleChars }: { preambleChars: number }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="session-resume-divider"
      className="flex items-center gap-2 py-2 my-2"
    >
      <span className="h-px flex-1 bg-success/30" />
      <span className="text-[10px] text-success/75 font-medium">
        {t("sessionResumeDivider.resumeLabel", { preambleChars })}
      </span>
      <span className="h-px flex-1 bg-success/30" />
    </div>
  );
}
