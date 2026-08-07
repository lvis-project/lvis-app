/**
 * Single source of truth for "is this URL safe to hand to an external-navigation
 * sink" — `shell.openExternal`, the side-browser webview, the in-app browser
 * tab, and the plugin host's `openExternalUrl`.
 *
 * Two rules, both structural (parse with `new URL()`, inspect the parsed
 * fields — never substring/`startsWith`/`includes`, the CodeQL "incomplete URL
 * substring sanitization" sink):
 *
 *  1. PROTOCOL — http(s) only. `shell.openExternal` will happily launch
 *     arbitrary handlers (file:// can execute, custom schemes can launch other
 *     apps), so the allowlist is positive: any scheme not named here is
 *     rejected by default.
 *  2. CREDENTIALS — reject `url.username` / `url.password`. `https://
 *     trusted.example@evil.tld/` reads as "trusted.example" to a human but
 *     navigates to evil.tld, so an embedded-credential URL is a phishing
 *     primitive regardless of scheme. Untrusted URLs reach these sinks (an MCP
 *     app's `ui/open-link` request, a plugin's `hostApi.openExternalUrl`, a
 *     tool-emitted preview target), so the rule is enforced here rather than at
 *     each caller.
 *
 * Every wiring delegates here — `src/ui/renderer/preview/url-safety.ts`,
 * `src/main/side-browser-webview.ts`, `src/ipc/domains/settings.ts`,
 * `src/boot/steps/plugin-runtime/external-url.ts`. Do not re-implement either
 * rule at a call site; a copy is how the credential rule went missing from two
 * of the four sinks.
 *
 * Pure / no-electron-import on purpose — keeps the unit test free of any
 * electron mocking and lets ipc-bridge call it without circular deps.
 */
export type ExternalUrlValidation =
  | { ok: true; url: string }
  | { ok: false; error: "invalid-url" }
  | { ok: false; error: "malformed-url" }
  | { ok: false; error: "embedded-credentials" }
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
  if (parsed.username || parsed.password) {
    return { ok: false, error: "embedded-credentials" };
  }
  return { ok: true, url: parsed.toString() };
}
