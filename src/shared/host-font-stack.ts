/**
 * Single source of truth for the host font stack.
 *
 * Issue #556 / #670 — host 본체 (`styles.css` body), plugin webview shell
 * (`plugin-ui-shell.html`), splash (`main.ts` inline), titlebar shell
 * (`window-titlebar-shell.ts`), and the `host.theme.changed` broadcast
 * (`ThemeProvider.notifyPluginTheme`) all need to render in identical
 * letterforms. Splitting the raw stack literal across 5 places guarantees
 * drift on the next typography tweak.
 *
 * This constant is the SoT for the JS side (ThemeProvider broadcast +
 * grep-zero invariant test). CSS / HTML surfaces cannot `import` a JS
 * literal at runtime, so they must mirror this value verbatim — the
 * `assistant-card-contrast` test enforces equality across all 5 occurrences.
 *
 * Stack design:
 *   1. `system-ui` first — matches the plugin webview UA default exactly,
 *      so host and plugin surfaces share OS letterforms (SF Pro on macOS,
 *      Segoe UI Variable on Windows, Cantarell/system on Linux).
 *   2. `-apple-system`, `BlinkMacSystemFont`, `"Segoe UI"`, `Roboto` —
 *      historical aliases for older browser engines that resolve to the
 *      same OS fonts but predate `system-ui` spec support.
 *   3. Korean fallback chain (`"Apple SD Gothic Neo"`, `"Noto Sans KR"`,
 *      `"Malgun Gothic"`) — `system-ui` itself does not ship Hangul
 *      glyphs, so CSS font-matching falls through codepoint-by-codepoint
 *      to a Hangul-capable face. These are NOT recovery fallback (No-
 *      Fallback-Code rule); they are unicode-range fallback that CSS
 *      spec requires for mixed Latin/Hangul rendering.
 *   4. `sans-serif` — absolute last-resort generic.
 */
export const HOST_FONT_STACK =
  "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, " +
  "\"Apple SD Gothic Neo\", \"Noto Sans KR\", \"Malgun Gothic\", sans-serif";
