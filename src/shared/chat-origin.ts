export type ChatInputOrigin =
  | "user-keyboard"
  | "plugin-emitted"
  | "llm-tool-arg"
  | "agent-message"
  | "file-content"


  | "queue-auto";

export type ChatSendInputOrigin = Extract<ChatInputOrigin, "user-keyboard" | "plugin-emitted" | "queue-auto">;
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
  return value === "user-keyboard" || value === "plugin-emitted" || value === "queue-auto";
}

export function hasUserKeyboardIntent(value: unknown): value is UserKeyboardIntent {
  if (!value || typeof value !== "object") return false;
  const payload = value as { inputOrigin?: unknown; userActivation?: unknown };
  return payload.inputOrigin === "user-keyboard" && payload.userActivation === true;
}
