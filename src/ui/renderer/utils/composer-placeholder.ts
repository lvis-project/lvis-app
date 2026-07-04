import { t } from "../../../i18n/runtime.js";
import type { SuggestedRepliesSnapshot } from "../hooks/use-suggested-replies.js";




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
