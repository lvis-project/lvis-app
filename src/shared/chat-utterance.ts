/**
 * Chat utterance taxonomy — 4 distinct modes for how a user-typed string
 * relates to the chat conversation state.
 *
 * Defined here as a single source of truth shared by:
 *   - renderer composer state machine (Composer.tsx, ChatView.tsx)
 *   - preload bridge (preload.ts — IPC payload shape)
 *   - main-process IPC handlers (ipc/domains/chat.ts)
 *   - engine ConversationLoop boundary-inject hook (for "guide" mode)
 *
 * | Mode               | Streaming state | Effect                                  |
 * | ------------------ | --------------- | --------------------------------------- |
 * | `"start"`          | idle            | begin a new turn from clean state       |
 * | `"abort-then-start"` | streaming     | abort current turn, then begin new one  |
 * | `"guide"`          | streaming       | queue text — inject as system note at   |
 * |                    |                 | the NEXT assistant-round boundary (i.e. |
 * |                    |                 | after current tool calls finish).       |
 * |                    |                 | Non-interrupting — current LLM call     |
 * |                    |                 | and its tool results are preserved.     |
 * | `"stop"`           | streaming       | abort current turn, no new turn         |
 *
 * The pre-existing `chat:guide` IPC (PR #621 era, deprecated in #623) had
 * abort-and-restart semantics — that behavior is now `"abort-then-start"` of
 * a chatSend with the guidance prompt template. The new `"guide"` mode is
 * deliberately different: it leaves the in-flight turn alone, so a
 * long-running tool round can complete before the model sees the redirect.
 */
export type ChatUtteranceMode =
  | "start"
  | "abort-then-start"
  | "guide"
  | "stop";
