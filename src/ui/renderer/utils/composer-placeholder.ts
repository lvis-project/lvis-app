import { t } from "../../../i18n/runtime.js";
import { isDarwin } from "../api-client.js";
import type { SuggestedRepliesSnapshot } from "../hooks/use-suggested-replies.js";




export function hasActiveSuggestedReplies(suggestedReplies: SuggestedRepliesSnapshot): boolean {
  return !suggestedReplies.isDismissed && suggestedReplies.text !== null;
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
  // The paste hint names a real key on the user's keyboard, so it is the
  // PLATFORM that decides it and not the language: macOS pastes with Command,
  // every other platform with Control. Substituted into one message rather than
  // selected between two, so a translator keeps a whole sentence to translate
  // and the modifier stays out of the catalog. `isDarwin()` is the renderer's
  // existing platform signal — the preload bridge, which answers false where
  // there is no Electron under the page.
  return t("composerPlaceholder.defaultHint", {
    pasteModifier: isDarwin() ? "⌘" : "Ctrl",
  });
}
