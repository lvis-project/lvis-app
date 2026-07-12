export type ChatInputOrigin =
  | "user-keyboard"
  | "plugin-emitted"
  /**
   * MCP App (`ui/message`) — an untrusted sandboxed app frame asked for its text
   * to enter the conversation. NEVER `user-keyboard`: the host cannot verify a
   * gesture claim made inside an untrusted iframe, so app text is staged for an
   * explicit user click (no active turn) or injected as round-boundary guidance
   * (active turn), and its tool calls are treated as non-user provenance.
   * Provenance travels in the `<app-message source="app:<serverId>">` envelope —
   * see `shared/mcp-app-message-source.ts`.
   */
  | "app-emitted"
  | "llm-tool-arg"
  | "agent-message"
  | "file-content"


  | "queue-auto";

export type ChatSendInputOrigin = Extract<
  ChatInputOrigin,
  "user-keyboard" | "plugin-emitted" | "app-emitted" | "queue-auto"
>;
export type TrustOriginWithUnknown = ChatInputOrigin | "unknown";

export interface ChatSendPayload {
  input: string;
  attachments?: unknown;
  inputOrigin: ChatSendInputOrigin;
  userActivation?: boolean;
  personaPromptId?: string;
}

export interface UserKeyboardIntentSnapshot {
  inputOrigin: "user-keyboard";
  token: string;
}

export interface UserKeyboardIntent {
  inputOrigin: "user-keyboard";
  userActivation: true;
}


/**
 * Turn-entry provenance. Do not pass this through as the tool invocation
 * provenance without reclassifying at the model/tool boundary.
 */
export function isUserKeyboardOrigin(origin: ChatInputOrigin): boolean {
  return origin === "user-keyboard";
}

export function isChatSendInputOrigin(value: unknown): value is ChatSendInputOrigin {
  return (
    value === "user-keyboard" ||
    value === "plugin-emitted" ||
    value === "app-emitted" ||
    value === "queue-auto"
  );
}

export function hasUserKeyboardIntent(value: unknown): value is UserKeyboardIntent {
  if (!value || typeof value !== "object") return false;
  const payload = value as { inputOrigin?: unknown; userActivation?: unknown };
  return payload.inputOrigin === "user-keyboard" && payload.userActivation === true;
}
