/**
 * Plugin UI Shell bootstrap — #237 Option B (CSP-safe external module)
 *
 * Loaded by `plugin-ui-shell.html` as `<script type="module" src="./plugin-ui-shell.js">`.
 *
 * Why this lives in its own host-owned file (not inline in the HTML):
 *   The shell document declares a strict CSP:
 *     script-src 'self' blob: http://localhost:* https://localhost:*
 *   …with no `'unsafe-inline'` and no nonce/hash. Electron's renderer enforces
 *   that policy, so an inline `<script type="module">` block would be silently
 *   refused — which is exactly the failure mode that produced fully blank
 *   embedded plugin areas and black detached windows: the bootstrap never
 *   ran, so even the error-text fallback paths below could not paint.
 *
 *   `'self'` covers the file:// origin of the shell HTML (Electron treats the
 *   directory of the document as the same-origin scope for `'self'`), so this
 *   sibling file loads under the same CSP without weakening it.
 *
 *   Installed plugin bundles are never imported directly from `file://`.
 *   Main resolves and containment-checks the registered entry, then preload
 *   returns the vetted source text. The shell imports that text through a
 *   local blob URL, keeping `script-src file:` out of the policy.
 *
 * Behavior is identical to the previous inline script:
 *   1. Ask main for the verified entry URL via `window.lvisPlugin.getEntryUrl`
 *      (no user-controllable URL ever reaches `import()`).
 *   2. Pre-paint host theme tokens before the plugin module mounts so the
 *      first React commit paints with correct host colors (no flash).
 *   3. Load the verified module source as a blob and call its
 *      `mount({ root, bridge })`.
 *   4. Surface user-visible error text on every failure path.
 */

(async () => {
  const root = document.getElementById("root");
  if (!root) {
    // Defensive: if the shell HTML was tampered with and `#root` is missing,
    // dump a plain-text error to <body> so the failure is at least visible
    // instead of producing a silent blank surface.
    const fallback = document.body || document.documentElement;
    if (fallback) {
      fallback.textContent = "[lvis] plugin-ui-shell: #root element missing.";
    }
    return;
  }
  if (!window.lvisPlugin || typeof window.lvisPlugin.getEntryUrl !== "function") {
    root.textContent = "[lvis] plugin-ui-shell: lvisPlugin bridge missing.";
    return;
  }
  // The host's `did-attach → registerPluginWebview` round-trip can lose
  // a race against this script when the plugin is updated and the
  // sidebar webview is re-attached with a fresh wcId. Main absorbs that
  // race with a 5s wait queue (pendingEntryUrlResolvers) so getEntryUrl
  // resolves once the binding lands; the queue's deadline returns the
  // same `not-registered` sentinel for genuinely missing registrations.
  let entry;
  try {
    entry = await window.lvisPlugin.getEntryUrl();
  } catch (err) {
    root.textContent = "[lvis] entry 조회 실패: " + (err?.message ?? String(err));
    return;
  }
  // Pre-paint theme tokens BEFORE the plugin module loads. This is
  // a pull (request/response) so it has no race vs the prior
  // register-time `wc.send` replay (which lost events sent before
  // preload's listener was attached). With tokens applied to
  // `documentElement` inline style here, the plugin's first React
  // commit paints with correct host colors from frame 0 — no flash
  // of fallback dark on light themes.
  try {
    if (typeof window.lvisPlugin.getTheme === "function") {
      const theme = await window.lvisPlugin.getTheme();
      if (theme && typeof theme === "object") {
        const r = document.documentElement;
        if (theme.theme) r.setAttribute("data-theme", String(theme.theme));
        if (theme.codeTheme) r.setAttribute("data-code-theme", String(theme.codeTheme));
        if (theme.chatTheme && theme.chatTheme !== "default") {
          r.setAttribute("data-chat-theme", String(theme.chatTheme));
        }
        const tokens = theme.tokens;
        if (tokens && typeof tokens === "object") {
          for (const [k, v] of Object.entries(tokens)) {
            if (typeof v === "string" && k.startsWith("--lvis-")) {
              r.style.setProperty(k, v);
            }
          }
        }
      }
    }
  } catch (err) {
    // Non-fatal — plugin still gets tokens via `host.theme.changed`
    // event after mount. Just paint with SDK :root defaults.
    console.warn("[lvis:plugin-shell] theme prefetch failed", err);
  }
  try {
    let importUrl = entry;
    if (typeof entry === "string" && entry.startsWith("file://")) {
      if (typeof window.lvisPlugin.getEntryModuleSource !== "function") {
        throw new Error("플러그인 모듈 소스 브리지를 찾을 수 없습니다.");
      }
      const source = await window.lvisPlugin.getEntryModuleSource();
      importUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    }
    try {
      const mod = await import(/* @vite-ignore */ importUrl);
      const mountFn =
        mod.mount ??
        mod.default?.mount ??
        (typeof mod.default === "function" ? mod.default : null);
      if (typeof mountFn !== "function") {
        throw new Error("플러그인 모듈에서 mount 함수를 찾을 수 없습니다.");
      }
      await mountFn({ root, bridge: window.lvisPlugin });
    } finally {
      if (typeof importUrl === "string" && importUrl.startsWith("blob:")) {
        URL.revokeObjectURL(importUrl);
      }
    }
  } catch (err) {
    root.style.color = "red";
    root.style.padding = "8px";
    root.style.fontSize = "12px";
    root.textContent = "[lvis] Plugin UI 로딩 실패: " + (err?.message ?? String(err));
    console.error("[lvis:plugin-shell] mount failed", err);
  }
})();
