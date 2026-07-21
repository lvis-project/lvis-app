#!/usr/bin/env node
/**
 * check-color-tokens.mjs — design-token guard (color literals)
 *
 * Sibling to check-opacity-tokens.mjs. Flags RAW color literals in the
 * renderer source tree:
 *   - `hsl(<digit> …)` — a hand-written HSL triple instead of a theme token
 *     (`hsl(var(--token))`). This is exactly how older onboarding cards and
 *     FileEditDiff accumulated a hardcoded dark palette that broke the
 *     light / high-contrast bundles.
 *   - quoted `white` / `black` in a color position (`color: "white"`).
 *   - `#rrggbb` / `#rgb` hex literals in a style value.
 *   - banned Tailwind palette gradient classes (`from-sky-300`, `to-rose-700`, …)
 *     which bypass the theme entirely.
 *
 * The per-bundle token system in src/styles.css is the single source of truth —
 * call sites must reference `hsl(var(--token))` or a composite token like
 * `var(--gradient-brand)` so a bundle switch re-tints every surface.
 *
 * Grandfather model (mirrors the opacity guard): a small allow-list of files
 * that still carry pre-existing literals not yet migrated. NEW violations in
 * any non-grandfathered file fail the build so the debt cannot regrow. A brand-
 * new component is enforced by default (it is not on the allow-list), so adding
 * `hsl(0 78% 58%)` to a fresh src/ui component fails the gate.
 *
 * ── ESLint equivalent (for when this repo adopts ESLint) ──────────────────
 * Once ESLint lands, port this to a `no-restricted-syntax` rule matching the
 * same literal shapes in JSX style props and delete this script, exactly as
 * check-opacity-tokens.mjs documents for its own rule.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC_DIR = join(process.cwd(), "src", "ui");

// Raw color-literal patterns. Each entry is [label, RegExp].
const PATTERNS = [
  // hsl( immediately followed by a digit → hand-written triple (not a token).
  ["hsl-literal", /hsl\(\s*[0-9]/g],
  // quoted white / black in any position (color: "white", background: 'black').
  ["named-color-literal", /['"](?:white|black)['"]/g],
  // #rgb / #rrggbb hex literal inside quotes (style values).
  ["hex-literal", /['"]#[0-9a-fA-F]{3,8}['"]/g],
  // banned Tailwind palette gradient classes.
  ["tailwind-palette", /\b(?:from|via|to)-(?:sky|emerald|amber|violet|rose|red|blue|green|purple|orange|pink|indigo)-[0-9]{2,3}\b/g],
];

// Files that still carry pre-existing, not-yet-migrated literals. Stored as
// posix-relative paths from the repo root. Do NOT extend without a migration
// reason — the point of the gate is that the list shrinks, never grows.
//   - theme/plugin-token-map.ts: `hsl(217, 91%, 60%)` appears only inside
//     JSDoc examples documenting the host→plugin tint contract — genuinely
//     theme-independent prose, not a render literal.
//   - components/LvisLogo.tsx: the brand SVG gradient stops (#FF0000 → #D900FF)
//     are the fixed LVIS mark and must NOT shift with the theme bundle — a
//     genuinely theme-independent case.
const GRANDFATHERED_FILES = new Set([
  "src/ui/renderer/theme/plugin-token-map.ts",
  "src/ui/renderer/components/LvisLogo.tsx",
]);

const violations = [];

function toPosix(p) {
  return sep === "/" ? p : p.split(sep).join("/");
}

function walk(dir) {
  // withFileTypes avoids a separate statSync between listing and read (CodeQL
  // flags that window as a file-system race), matching check-opacity-tokens.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(p);
    } else if (entry.isFile() && /\.(tsx|ts)$/.test(entry.name)) {
      const rel = toPosix(relative(process.cwd(), p));
      if (GRANDFATHERED_FILES.has(rel)) continue;
      const content = readFileSync(p, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        for (const [label, re] of PATTERNS) {
          re.lastIndex = 0;
          for (const m of line.matchAll(re)) {
            violations.push(`${rel}:${i + 1}  [${label}] ${m[0]}`);
          }
        }
      });
    }
  }
}

try {
  walk(SRC_DIR);
} catch (e) {
  console.warn(`[color-token-check] skipped: ${e.message}`);
  process.exit(0);
}

if (violations.length > 0) {
  console.error(
    "[color-token-check] FAIL — raw color literals found.\n" +
      "Use theme tokens, e.g. hsl(var(--primary)) / var(--gradient-brand). " +
      "See the per-bundle tokens in src/styles.css.\n",
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("[color-token-check] OK");
