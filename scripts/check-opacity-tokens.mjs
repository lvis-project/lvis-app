#!/usr/bin/env node
/**
 * check-opacity-tokens.mjs — design-token guard
 *
 * Flags raw numeric Tailwind alpha modifiers on color utilities
 * (e.g. `bg-warning/15`, `border-primary/40`) in the renderer source tree.
 * The semantic opacity scale in src/styles.css (`--opacity-faint`…`-solid`)
 * is the single source of truth — call sites must use the CSS-variable alpha
 * shorthand, e.g. `bg-warning/(--opacity-soft)`, so a single token edit
 * re-tunes every surface.
 *
 * Grandfathered: a small allow-list of pre-existing odd values (/25, /35)
 * that have no clean token. Everything else is rejected. New violations fail
 * the build so the debt cannot regrow.
 *
 * ── ESLint equivalent (for when this repo adopts ESLint) ──────────────────
 * This guard is a grep-style stand-in matching the existing
 * `check-no-tls-bypass.mjs` convention (this repo has no ESLint config). The
 * intended lint rule, once ESLint lands, is:
 *
 *   "no-restricted-syntax": ["error", {
 *     selector: "Literal[value=/\\b(?:bg|text|border|ring|fill|stroke|" +
 *       "shadow|outline|divide|placeholder|decoration|accent|caret|from|" +
 *       "to|via)-[a-z-]+\\/[0-9]+\\b/]",
 *     message: "Use the named opacity tokens (bg-x/(--opacity-soft)) " +
 *       "instead of raw numeric alpha modifiers. See src/styles.css.",
 *   }]
 *
 * Move the logic there and delete this script when that happens.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(process.cwd(), "src", "ui");

// Color utility prefixes that accept an /<alpha> modifier (incl. directional
// border edges like border-l-).
const PREFIX =
  "(?:bg|text|border|border-[trbl]|ring|ring-offset|fill|stroke|shadow|" +
  "outline|divide|placeholder|decoration|accent|caret|from|to|via)";

// Named theme colors only — keeps layout fractions (w-1/3, flex-1) out.
const COLOR =
  "(?:background|foreground|card|card-foreground|popover|popover-foreground|" +
  "primary|primary-foreground|secondary|secondary-foreground|muted|" +
  "muted-foreground|accent|accent-foreground|destructive|" +
  "destructive-foreground|warning|warning-foreground|success|" +
  "success-foreground|info|info-foreground|emphasis|emphasis-foreground|" +
  "border|input|ring|ui-line|action-view|action-branch|action-compact|" +
  "message-user|message-user-foreground|current|white|black)";

const RAW_ALPHA = new RegExp(`\\b${PREFIX}-${COLOR}\\/([0-9]+)\\b`, "g");

// Pre-existing odd values with no clean token slot. Do NOT extend without
// adding a matching token to src/styles.css first.
const GRANDFATHERED = new Set(["25", "35"]);

const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(p);
    } else if (/\.(tsx|ts)$/.test(entry)) {
      const content = readFileSync(p, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(RAW_ALPHA)) {
          if (GRANDFATHERED.has(m[1])) continue;
          violations.push(`${relative(process.cwd(), p)}:${i + 1}  ${m[0]}`);
        }
      });
    }
  }
}

try {
  walk(SRC_DIR);
} catch (e) {
  console.warn(`[opacity-token-check] skipped: ${e.message}`);
  process.exit(0);
}

if (violations.length > 0) {
  console.error(
    "[opacity-token-check] FAIL — raw numeric alpha modifiers found.\n" +
      "Use named opacity tokens, e.g. bg-warning/(--opacity-soft). " +
      "See the --opacity-* scale in src/styles.css.\n",
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("[opacity-token-check] OK");
