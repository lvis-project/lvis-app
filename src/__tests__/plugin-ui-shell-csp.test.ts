/**
 * Regression: Plugin UI Shell must not require inline script execution.
 *
 * The shell document declares a strict CSP:
 *   script-src 'self' blob: http://localhost:* https://localhost:*
 * with no `'unsafe-inline'`, no nonce, no hash. Historically the shell
 * embedded its bootstrap as `<script type="module">…</script>`, which the
 * renderer silently refused — producing fully blank embedded plugin areas
 * and black detached windows because even the error-text fallback paths in
 * the bootstrap never executed.
 *
 * These tests lock in the fix:
 *   1. The shell HTML contains no inline executable <script> block.
 *   2. The shell HTML references an external host-owned bootstrap
 *      (`./plugin-ui-shell.js`) via `<script type="module" src="…">`.
 *   3. The CSP is unchanged in spirit — still no `'unsafe-inline'`, still
 *      includes `'self'` so the sibling bootstrap loads, and does NOT
 *      include `file:`. Installed plugin modules are read by main after the
 *      registered entry path passes containment checks, then imported as blob
 *      modules inside the shell.
 *   4. The build pipeline copies the bootstrap to `dist/src/` alongside
 *      the HTML, and the dev launcher copies/watches it too.
 *   5. The bootstrap source itself contains the user-visible error fallback
 *      text paths so a CSP regression would be visible (not blank).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirnameLocal = dirname(__filename);
const repoRoot = resolve(__dirnameLocal, "..", "..");
const shellHtmlPath = resolve(repoRoot, "src/plugin-ui-shell.html");
const shellJsPath = resolve(repoRoot, "src/plugin-ui-shell.js");
const packageJsonPath = resolve(repoRoot, "package.json");
const devScriptPath = resolve(repoRoot, "scripts/run-electron-dev.mjs");

const shellHtml = readFileSync(shellHtmlPath, "utf8");
const shellJs = readFileSync(shellJsPath, "utf8");
const packageJson = readFileSync(packageJsonPath, "utf8");
const devScript = readFileSync(devScriptPath, "utf8");

function extractCsp(html: string): string {
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  if (!m) throw new Error("CSP meta tag not found in plugin-ui-shell.html");
  return m[1];
}

function extractScripts(html: string): Array<{ raw: string; attrs: string; body: string }> {
  const out: Array<{ raw: string; attrs: string; body: string }> = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({ raw: m[0], attrs: m[1], body: m[2] });
  }
  return out;
}

describe("plugin-ui-shell — CSP-safe external bootstrap", () => {
  it("declares a strict CSP without 'unsafe-inline' for script-src", () => {
    const csp = extractCsp(shellHtml);
    // Must include 'self' so the sibling bootstrap loads.
    expect(csp).toMatch(/script-src[^;]*'self'/);
    // Must NOT relax script-src with 'unsafe-inline'. Anyone tempted to
    // "fix" a blank shell by adding 'unsafe-inline' should fail this test
    // and read the rationale in src/plugin-ui-shell.js instead.
    const scriptSrc = csp.match(/script-src[^;]*/i)?.[0] ?? "";
    // Do not allow arbitrary local JS execution from the plugin webview.
    // Installed marketplace plugins are read by main and imported as blob:
    // modules after registry/realpath containment checks.
    expect(scriptSrc).not.toMatch(/\bfile:/);
    expect(scriptSrc).toMatch(/\bblob:/);
    expect(scriptSrc).not.toMatch(/'unsafe-inline'/);
    // Defensive: also no nonce/hash hack — the fix must stay declarative.
    expect(scriptSrc).not.toMatch(/'nonce-/);
    expect(scriptSrc).not.toMatch(/'sha(256|384|512)-/);
  });

  it("contains no inline executable <script> block (must use external src)", () => {
    const scripts = extractScripts(shellHtml);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) {
      const hasSrc = /\bsrc\s*=/.test(s.attrs);
      const body = s.body.trim();
      // Either it's an external script (src attribute) with empty body,
      // or it's a non-executable data block (e.g. type="application/json").
      // No inline JS module/classic script body is allowed.
      const typeMatch = s.attrs.match(/\btype\s*=\s*"([^"]+)"/i);
      const type = typeMatch?.[1].toLowerCase() ?? "";
      const isExecutableType = type === "" || type === "module" || type === "text/javascript" || type === "application/javascript";
      if (isExecutableType) {
        expect(
          hasSrc,
          `Inline executable <script> blocks are not CSP-safe under script-src 'self' (no 'unsafe-inline'). Move bootstrap to an external sibling file. Found: ${s.raw.slice(0, 120)}…`,
        ).toBe(true);
        expect(body, "External executable <script> must have an empty body").toBe("");
      }
    }
  });

  it("references the host-owned external bootstrap as a module script", () => {
    // Match `<script type="module" src="./plugin-ui-shell.js">`. Path must be
    // relative-sibling so it resolves to `dist/src/plugin-ui-shell.js` under
    // the file:// origin covered by `'self'`.
    expect(shellHtml).toMatch(
      /<script\s+type="module"\s+src="\.\/plugin-ui-shell\.js"\s*>\s*<\/script>/,
    );
  });

  it("ships the bootstrap source with the user-visible error fallbacks", () => {
    // If CSP ever blocks the bootstrap again, regression manifests as a
    // blank surface. The fallback strings below are what the user sees on
    // any *recoverable* failure; their presence is what makes the failure
    // mode visible instead of silent.
    expect(shellJs).toContain("lvisPlugin bridge missing");
    expect(shellJs).toContain("Plugin UI 로딩 실패");
    expect(shellJs).toContain("entry 조회 실패");
    // Sanity: the bootstrap must still call the bridge entry-resolver.
    expect(shellJs).toMatch(/lvisPlugin\.getEntryUrl/);
    // File-backed entries must be converted to blob: modules before import.
    expect(shellJs).toMatch(/lvisPlugin\.getEntryModuleSource/);
    expect(shellJs).toMatch(/URL\.createObjectURL/);
    expect(shellJs).toMatch(/URL\.revokeObjectURL/);
    expect(shellJs).toMatch(/import\(\s*\/\*\s*@vite-ignore\s*\*\/\s*importUrl\s*\)/);
  });

  it("build script copies plugin-ui-shell.js into dist/src/", () => {
    // The package.json `build` script invokes `copy-build-assets.mjs` with
    // src/dest pairs. We don't want this to silently regress to "html only".
    expect(packageJson).toMatch(
      /src\/plugin-ui-shell\.js\s+dist\/src\/plugin-ui-shell\.js/,
    );
    // And the HTML pair must still be there.
    expect(packageJson).toMatch(
      /src\/plugin-ui-shell\.html\s+dist\/src\/plugin-ui-shell\.html/,
    );
  });

  it("dev launcher copies and watches the plugin-ui-shell.js asset", () => {
    // The dev path bypasses `bun run build`, so it has its own copy/watch.
    // Both the HTML and JS sibling must be wired up there.
    expect(devScript).toMatch(/src\/plugin-ui-shell\.html/);
    expect(devScript).toMatch(/src\/plugin-ui-shell\.js/);
    expect(devScript).toMatch(/dist\/src\/plugin-ui-shell\.html/);
    expect(devScript).toMatch(/dist\/src\/plugin-ui-shell\.js/);
  });

});
