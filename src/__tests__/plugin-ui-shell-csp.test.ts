/**
 * Regression: Plugin UI Shell must not require inline script execution.
 *
 * The shell document declares a strict CSP:
 *   script-src 'self' lvis-plugin:
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
 *      include `file:`. Installed plugin modules load through the
 *      per-plugin `lvis-plugin:` asset protocol after the registered entry
 *      path passes containment checks.
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
const buildAssetsPath = resolve(repoRoot, "scripts/lib/build-assets.mjs");

const shellHtml = readFileSync(shellHtmlPath, "utf8");
const shellJs = readFileSync(shellJsPath, "utf8");
const packageJson = readFileSync(packageJsonPath, "utf8");
const devScript = readFileSync(devScriptPath, "utf8");
const buildAssets = readFileSync(buildAssetsPath, "utf8");

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
    // Installed marketplace plugins are served by main's per-partition
    // lvis-plugin: asset protocol after registry/realpath containment checks.
    expect(scriptSrc).not.toMatch(/\bfile:/);
    expect(scriptSrc).toMatch(/\blvis-plugin:/);
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
    expect(shellJs).toContain("Plugin UI failed to load");
    expect(shellJs).toContain("entry lookup failed");
    // Sanity: the bootstrap must still call the bridge entry-resolver.
    expect(shellJs).toMatch(/lvisPlugin\.getEntryUrl/);
    // File-backed entries must not be imported as file:// or blob: modules:
    // main returns a lvis-plugin:// URL so relative imports/assets keep the
    // original plugin install-directory base URL.
    expect(shellJs).not.toMatch(/lvisPlugin\.getEntryModuleSource/);
    expect(shellJs).not.toMatch(/URL\.createObjectURL/);
    expect(shellJs).not.toMatch(/URL\.revokeObjectURL/);
    expect(shellJs).toMatch(/import\(\s*\/\*\s*@vite-ignore\s*\*\/\s*entry\s*\)/);
  });

  it("build script copies plugin-ui-shell.js into dist/src/", () => {
    // The build script delegates to the shared asset registry; package.json
    // should not become a second src/dest list again.
    expect(packageJson).toContain("node scripts/copy-build-assets.mjs");
    expect(packageJson).not.toContain("src/plugin-ui-shell.html dist/src/plugin-ui-shell.html");
    expect(packageJson).not.toContain("src/plugin-ui-shell.js dist/src/plugin-ui-shell.js");
    expect(buildAssets).toContain('src: "src/plugin-ui-shell.html"');
    expect(buildAssets).toContain('out: "dist/src/plugin-ui-shell.html"');
    expect(buildAssets).toContain('src: "src/plugin-ui-shell.js"');
    expect(buildAssets).toContain('out: "dist/src/plugin-ui-shell.js"');
  });

  it("dev launcher copies and watches the plugin-ui-shell.js asset", () => {
    // The dev path bypasses `bun run build`, so it has its own copy/watch.
    // Both the HTML and JS sibling must come from the same registry as build.
    expect(devScript).toContain('import { resolveBuildAssets } from "./lib/build-assets.mjs";');
    expect(devScript).toContain('resolveBuildAssets(repoRoot, "plugin-shell")');
    expect(buildAssets).toContain('category: "plugin-shell"');
  });

});
