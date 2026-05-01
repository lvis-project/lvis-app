export const TOAST_FIELD_MAX = 120;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
export function safeField(input: unknown, max: number = TOAST_FIELD_MAX): string {
  return String(input ?? "unknown").replace(CONTROL_CHARS, "").slice(0, max);
}
