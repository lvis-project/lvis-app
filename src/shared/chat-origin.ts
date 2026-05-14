export type ChatInputOrigin =
  | "user-keyboard"
  | "plugin-emitted"
  | "llm-tool-arg"
  | "file-content"
  // queue-auto: renderer-side message-queue 가 brake-point 에서 자동 인입.
  // user-keyboard 와 동일한 trust boundary (사용자가 명시 입력한 텍스트가
  // 큐에 누적된 것) 이지만 IPC stream context 에서 발생하므로 navigator.
  // userActivation 검사는 우회. validator 가 별도 allow-list 처리.
  | "queue-auto";

export type ChatSendInputOrigin = Extract<ChatInputOrigin, "user-keyboard" | "plugin-emitted" | "queue-auto">;
export type TrustOriginWithUnknown = ChatInputOrigin | "unknown";

export interface ChatSendPayload {
  input: string;
  attachments?: unknown;
  inputOrigin: ChatSendInputOrigin;
  userActivation?: boolean;
  rolePrompt?: {
    name: string;
    systemPromptAdd: string;
  };
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
