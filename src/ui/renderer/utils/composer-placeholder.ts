import { t } from "../../../i18n/runtime.js";
import type { SuggestedRepliesSnapshot } from "../hooks/use-suggested-replies.js";

/**
 * Compute the composer textarea placeholder text.
 *
 * The placeholder shares vertical space with the suggested-replies chip
 * row. When chips are live (LLM emitted a non-empty `<suggested_replies>`
 * block and the user hasn't dismissed them) the static hint creates
 * visual conflict — the user sees both "캘린더 직접 열게 | 나중에 할게"
 * chips and the long "Enter 전송 · /command 사용 가능" placeholder
 * simultaneously. We suppress the placeholder while chips are active so
 * the user can focus on the LLM's contextual suggestions.
 *
 * Priority: API-key absent > suggestions active > streaming > default hint.
 */
export function hasActiveSuggestedReplies(suggestedReplies: SuggestedRepliesSnapshot): boolean {
  return (
    !suggestedReplies.isDismissed &&
    (suggestedReplies.best !== null || suggestedReplies.alternates.length > 0)
  );
}

export function computeComposerPlaceholder(opts: {
  hasApiKey: boolean | null | undefined;
  streaming: boolean;
  suggestedReplies: SuggestedRepliesSnapshot;
}): string {
  if (opts.hasApiKey === false) return t("composerPlaceholder.apiKeyMissing");
  if (hasActiveSuggestedReplies(opts.suggestedReplies)) {
    return "";
  }
  if (opts.streaming) return t("composerPlaceholder.streamingHint");
  return t("composerPlaceholder.defaultHint");
}
