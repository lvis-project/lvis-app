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
 * and fails the build when they disagree. Fail-closed — a missing token or a
 * missing constant is a failure, not a skip, so deleting one side cannot make
 * the check pass by having nothing to compare.
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
 */
const MIRRORS = [
  { css: "--chrome-gap", ts: "SHELL_GUTTER" },
  { css: "--chrome-gap-tight", ts: "CHROME_GAP_TIGHT" },
];

const CSS_REL = join("src", "styles.css");
const TS_REL = join("src", "shared", "shell-geometry.ts");

function parseArgs(argv) {
  const rootFlag = argv.indexOf("--root");
  return { root: rootFlag >= 0 ? argv[rootFlag + 1] : process.cwd() };
}

/**
 * Every `--name: <n>px;` declaration of `name`, as numbers. Values that are
 * not a bare px literal (a `var()` alias, a `calc()`) are deliberately not
 * matched: they have no second copy to drift from, so they are not this
 * gate's business.
 */
function cssPixelDeclarations(source, name) {
  const re = new RegExp(`(^|[;{\\s])${name}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px\\s*;`, "g");
  return [...source.matchAll(re)].map((m) => Number(m[2]));
}

/** The `export const NAME = <n>;` value, as a number, or undefined. */
function tsConstant(source, name) {
  const m = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\s*;`));
  return m ? Number(m[1]) : undefined;
}

const { root } = parseArgs(process.argv.slice(2));
const failures = [];

let css;
let ts;
try {
  css = readFileSync(join(root, CSS_REL), "utf8");
  ts = readFileSync(join(root, TS_REL), "utf8");
} catch (e) {
  console.error(`[shell-geometry-tokens] FAIL — cannot read a mirror side: ${e.message}`);
  process.exit(1);
}

for (const { css: cssName, ts: tsName } of MIRRORS) {
  const declared = cssPixelDeclarations(css, cssName);
  const constant = tsConstant(ts, tsName);

  if (declared.length === 0) {
    failures.push(`${cssName}: no px declaration found in ${CSS_REL}`);
    continue;
  }
  if (declared.length > 1 && new Set(declared).size > 1) {
    failures.push(`${cssName}: declared more than once with different values (${declared.join(", ")}) in ${CSS_REL}`);
    continue;
  }
  if (constant === undefined) {
    failures.push(`${tsName}: no numeric \`export const\` found in ${TS_REL}`);
    continue;
  }
  if (declared[0] !== constant) {
    failures.push(`${cssName} is ${declared[0]}px in ${CSS_REL} but ${tsName} is ${constant} in ${TS_REL}`);
  }
}

if (failures.length > 0) {
  console.error(
    "[shell-geometry-tokens] FAIL — the CSS tokens and their TypeScript mirrors disagree.\n" +
      "These are one fact written in two languages; change both or neither.\n",
  );
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`[shell-geometry-tokens] OK pairs=${MIRRORS.length}`);
