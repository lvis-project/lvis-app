export type ChatInputOrigin =
  | "user-keyboard"
  | "plugin-emitted"
  | "llm-tool-arg"
  | "file-content";

/**
 * Turn-entry provenance. Do not pass this through as the tool invocation
 * provenance without reclassifying at the model/tool boundary.
 */
export function isUserKeyboardOrigin(origin: ChatInputOrigin): boolean {
  return origin === "user-keyboard";
}
