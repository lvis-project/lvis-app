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
  /** Absent on a surface that has no suggested-replies feed (the side chat). */
  suggestedReplies?: SuggestedRepliesSnapshot;
  subscriptionPending?: boolean;
  subscriptionUnavailable?: boolean;
}): string {
  if (opts.subscriptionPending) return t("subscriptionProvidersSection.statusChecking");
  if (opts.subscriptionUnavailable) return t("formatIpcError.subscriptionChatUnavailable");
  if (opts.hasApiKey === false) return t("composerPlaceholder.apiKeyMissing");
  if (opts.suggestedReplies && hasActiveSuggestedReplies(opts.suggestedReplies)) {
    return "";
  }
  if (opts.streaming) return t("composerPlaceholder.streamingHint");
  return t("composerPlaceholder.defaultHint");
}
