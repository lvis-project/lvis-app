import { Buffer } from "node:buffer";
import { hasControlChars } from "./display-safe-text.js";

export const MAX_TOOL_USE_ID_UTF8_BYTES = 256;


export function isValidToolUseId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_TOOL_USE_ID_UTF8_BYTES &&
    !hasControlChars(value);
}

export function assertValidToolUseId(
  value: unknown,
  label = "tool use ID",
): asserts value is string {
  if (!isValidToolUseId(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}
