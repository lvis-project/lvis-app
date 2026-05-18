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
 * Priority: API-key absent > streaming > chips active > default hint.
 */
export function computeComposerPlaceholder(opts: {
  hasApiKey: boolean | null | undefined;
  streaming: boolean;
  suggestedReplies: SuggestedRepliesSnapshot;
}): string {
  if (opts.hasApiKey === false) return "API 키를 먼저 설정해 주세요...";
  if (opts.streaming) return "메시지 큐에 추가됩니다 (즉시 인터럽트는 ⌘⏎)";
  if (opts.suggestedReplies.best !== null && !opts.suggestedReplies.isDismissed) {
    return "";
  }
  return "질문 입력 (Enter 전송 · Cmd/Ctrl+V 첨부) · /command 사용 가능";
}
