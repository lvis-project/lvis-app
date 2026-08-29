#!/usr/bin/env node
/**
 * check-shell-geometry-tokens.mjs — SSOT mirror guard
 *
 * `src/styles.css` and `src/shared/shell-geometry.ts` each hold a copy of the
 * same pixel counts, and they have to. The CSS tokens are what the class
 * strings read; the TypeScript constants are what the arithmetic that happens
 * in JS reads — the main process's window-bounds math, the chat group's split
 * math, the title band's lead padding. Neither language can import the other's
 * value, so the duplication is unavoidable; what is avoidable is the two
 * drifting apart silently, which is exactly the failure this whole
 * consolidation exists to prevent.
 *
 * This gate closes that last gap: for every pair below it parses the `:root`
 * declaration out of the stylesheet and the `export const` out of the module
 * and fails the build when they disagree.
 *
 * Fail-closed throughout. A missing token, a missing constant, a value it
 * cannot resolve, or a name defined twice is a FAILURE, not a skip — a guard
 * that answers "nothing to compare" with exit 0 is worse than no guard,
 * because it reports OK forever. Comments are stripped before anything is
 * matched, so neither a commented-out declaration nor a historical value left
 * in a docstring can stand in for the live one.
 *
 * Sits beside `check-opacity-tokens.mjs` / `check-color-tokens.mjs` in
 * `bun run build`, and follows their conventions: plain node, no TypeScript
 * loader (the constant is read as source text, not imported, so the gate runs
 * before and independently of any build step).
 *
 * `--root <dir>` overrides the repo root, which is how the unit test in
 * `test/scripts/` drives it against fixture trees.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The mirrored pairs. Add to this list whenever a `--chrome-*` / `--shell-*`
 * pixel count gains a TypeScript twin — that is the moment the drift becomes
 * possible, and the moment this gate has to know about it.
 *
 * `--shell-card-inset` is here because it is load-bearing on the TS side twice
 * over: `CLUSTER_LEAD_PAD_DARWIN` subtracts the card's left inset to re-express
 * the traffic-light clearance from the card's edge, and `SIDE_PANEL_CARD_INSET`
 * doubles it into the reserve the main process sizes the window by. It is
 * written in CSS as an alias (`var(--chrome-gap)`) rather than a literal, which
 * is why this gate resolves one level of `var()` instead of only reading px.
 */
const MIRRORS = [
  { css: "--chrome-gap", ts: "SHELL_GUTTER" },
  { css: "--chrome-gap-tight", ts: "CHROME_GAP_TIGHT" },
  { css: "--shell-card-inset", ts: "SHELL_GUTTER" },
];

const CSS_REL = join("src", "styles.css");
const TS_REL = join("src", "shared", "shell-geometry.ts");

function parseArgs(argv) {
  const flag = argv.indexOf("--root");
  if (flag === -1) return { root: process.cwd() };
  const value = argv[flag + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error("[shell-geometry-tokens] FAIL — `--root` needs a directory, e.g. `--root /path/to/checkout`.");
    process.exit(1);
  }
  return { root: value };
}

/**
 * Source with its comments blanked out, so a declaration that has been
 * commented away cannot be read as live and a value quoted in prose cannot
 * shadow the real one. Quote-aware: a `/*` or `//` inside a string literal is
 * content, not a comment. Newlines survive so anything downstream that counts
 * lines still can.
 */
function stripComments(source, { lineComments }) {
  let out = "";
  let quote = null;
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const span = end === -1 ? source.slice(i) : source.slice(i, end + 2);
      out += span.replace(/[^\n]/g, " ");
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (lineComments && char === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      out += " ";
      i = end === -1 ? source.length : end;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/**
 * Every custom-property declaration in the stylesheet, as raw value strings
 * keyed by name. A declaration ends at `;` or at the `}` that closes its block,
 * so the last one in a block needs no trailing semicolon; `!important` is
 * dropped because it changes the cascade, not the value. The leading character
 * class keeps `var(--x)` references from being read as declarations of `--x`.
 */
function cssDeclarations(source) {
  const declarations = new Map();
  const re = /(?:^|[;{}\s])(--[A-Za-z0-9_-]+)\s*:\s*([^;}]*)/g;
  for (const match of source.matchAll(re)) {
    const value = match[2].replace(/!important\s*$/i, "").trim();
    const existing = declarations.get(match[1]);
    if (existing) existing.push(value);
    else declarations.set(match[1], [value]);
  }
  return declarations;
}

const PX = /^(-?\d+(?:\.\d+)?)px$/;
const VAR_ALIAS = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/;

/**
 * A declared token as a number of px, following at most one `var()` alias.
 * Returns `{ px }` or `{ error }` — never a silent skip. One level is
 * deliberate: an alias chain is a design smell in a token file this small, and
 * refusing to walk it keeps this resolver from having to detect cycles.
 */
function resolvePx(name, declarations, { allowAlias = true } = {}) {
  const values = declarations.get(name);
  if (!values || values.length === 0) {
    return { error: `${name}: not declared in ${CSS_REL} (a commented-out declaration does not count)` };
  }
  const resolved = [];
  for (const value of values) {
    const px = PX.exec(value);
    if (px) {
      resolved.push(Number(px[1]));
      continue;
    }
    const alias = VAR_ALIAS.exec(value);
    if (alias && allowAlias) {
      const target = resolvePx(alias[1], declarations, { allowAlias: false });
      if (target.error) {
        return { error: `${name}: aliases ${alias[1]}, which does not resolve — ${target.error}` };
      }
      resolved.push(target.px);
      continue;
    }
    return {
      error: `${name}: value \`${value}\` is neither a px literal nor a single-level var() alias, so it has no number to compare`,
    };
  }
  const distinct = [...new Set(resolved)];
  if (distinct.length > 1) {
    return { error: `${name}: declared more than once with different values (${distinct.join(", ")}) in ${CSS_REL}` };
  }
  return { px: distinct[0] };
}

/** Every `export const NAME = <n>;` in the module, as numbers keyed by name. */
function tsConstants(source) {
  const constants = new Map();
  const re = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;/g;
  for (const match of source.matchAll(re)) {
    const existing = constants.get(match[1]);
    if (existing) existing.push(Number(match[2]));
    else constants.set(match[1], [Number(match[2])]);
  }
  return constants;
}

const { root } = parseArgs(process.argv.slice(2));

let cssSource;
let tsSource;
try {
  cssSource = readFileSync(join(root, CSS_REL), "utf8");
  tsSource = readFileSync(join(root, TS_REL), "utf8");
} catch (e) {
  console.error(`[shell-geometry-tokens] FAIL — cannot read a mirror side: ${e.message}`);
  process.exit(1);
}

const declarations = cssDeclarations(stripComments(cssSource, { lineComments: false }));
const constants = tsConstants(stripComments(tsSource, { lineComments: true }));
const failures = [];

for (const { css: cssName, ts: tsName } of MIRRORS) {
  const token = resolvePx(cssName, declarations);
  if (token.error) {
    failures.push(token.error);
    continue;
  }
  const defined = constants.get(tsName);
  if (!defined || defined.length === 0) {
    failures.push(`${tsName}: no numeric \`export const\` found in ${TS_REL} (a value quoted in a comment does not count)`);
    continue;
  }
  if (defined.length > 1) {
    failures.push(`${tsName}: defined ${defined.length} times in ${TS_REL} (${defined.join(", ")})`);
    continue;
  }
  if (token.px !== defined[0]) {
    failures.push(`${cssName} is ${token.px}px in ${CSS_REL} but ${tsName} is ${defined[0]} in ${TS_REL}`);
  }
}

if (failures.length > 0) {
  console.error(
    "[shell-geometry-tokens] FAIL — the CSS tokens and their TypeScript mirrors disagree.\n" +
      "These are one fact written in two languages; change both or neither.\n",
  );
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`[shell-geometry-tokens] OK pairs=${MIRRORS.length}`);
