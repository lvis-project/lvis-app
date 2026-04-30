/**
 * Strict URL allowlist for `shell.openExternal`.
 *
 * `shell.openExternal` will happily launch arbitrary handlers (file:// can
 * execute, custom schemes can launch other apps), so any renderer-driven
 * call must funnel through this validator before main forwards to electron.
 * Only http(s) is allowed; everything else is rejected with a structured
 * error so the renderer can surface a sensible message.
 *
 * Pure / no-electron-import on purpose — keeps the unit test free of any
 * electron mocking and lets ipc-bridge call it without circular deps.
 */
export type ExternalUrlValidation =
  | { ok: true; url: string }
  | { ok: false; error: "invalid-url" }
  | { ok: false; error: "malformed-url" }
  | { ok: false; error: "disallowed-protocol"; protocol: string };

export function validateExternalUrl(input: unknown): ExternalUrlValidation {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, error: "invalid-url" };
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: "malformed-url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "disallowed-protocol", protocol: parsed.protocol };
  }
  return { ok: true, url: parsed.toString() };
}
