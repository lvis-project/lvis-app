import { Buffer } from "node:buffer";

export const MAX_TOOL_USE_ID_UTF8_BYTES = 256;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export function isValidToolUseId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_TOOL_USE_ID_UTF8_BYTES &&
    !CONTROL_CHARACTER_PATTERN.test(value);
}

export function assertValidToolUseId(
  value: unknown,
  label = "tool use ID",
): asserts value is string {
  if (!isValidToolUseId(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}
