#!/usr/bin/env node
/**
 * check-no-inline-channels.mjs — #1409 C2 + C11 + M1 CI guard
 *
 * EVERY `src/ipc/domains/*.ts` IPC domain, host/plugin preload entry, selected
 * main-side producer, and external-surface consumer must reference Electron
 * wire channels ONLY through the `src/contract/` SOT (`CHANNELS.*`). The guard
 * rejects actual string, template, and statically concatenated literals in
 * the `lvis:`, `marketplace:`, and `window:` namespaces while ignoring comments
 * and documentation.
 *
 * The domain directory is read dynamically (M1: cluster-review finding —
 * previously only the C2-swept chat/plugins/settings domains were guarded, so
 * the remaining domains could re-author `lvis:*` literals independently). The
 * `__tests__/` subdirectory is excluded automatically (it is a directory, not
 * a `.ts` file) — domain behavior tests legitimately assert on literal
 * channel strings.
 *
 * The preload surface split (#1409 C11 / #1411) moved the host bridge into
 * `src/preload/{public-surface,internal-surface,gesture-intent}.ts`; the whole
 * `src/preload/` directory is scanned so a new submodule is covered
 * automatically. Run standalone with `node scripts/check-no-inline-channels.mjs`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  SyntaxKind,
} from "typescript/unstable/ast";
import { parseSourceFiles } from "./lib/ts7-ast.mjs";

const rootArgIndex = process.argv.indexOf("--root");
const ROOT = rootArgIndex >= 0
  ? resolve(process.argv[rootArgIndex + 1] ?? "")
  : process.cwd();

/** Read the top-level `.ts` modules of a directory (subdirs like `__tests__/`
 *  are excluded by the `.endsWith(".ts")` filter). */
const tsModulesIn = (dir) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${dir}/${f}`);

const TARGETS = [
  // Every IPC domain module (read dynamically so a new domain is covered
  // automatically).
  ...tsModulesIn("src/ipc/domains"),
  "src/preload.ts",
  // Every TS module in the preload surface split (public/internal/gesture).
  ...tsModulesIn("src/preload"),
  // The external-surface stack (#1409/#1436): contract consumers must never
  // re-inline a wire literal — dispatcher, HTTP server, SDK facade, CLI.
  // (src/contract itself is the SOT where the literals are DEFINED — excluded.)
  ...tsModulesIn("src/api"),
  ...tsModulesIn("src/sdk"),
  ...tsModulesIn("src/cli"),
  // Separate sandboxed plugin-webview preload entry. This is not under
  // src/preload/, so it must be listed explicitly.
  "src/plugin-preload.ts",
  // Main-side producers paired with the preload/domain consumers above.
  "src/boot/plugins.ts",
  "src/boot/steps/ipc-bridge.ts",
  "src/boot/steps/post-boot.ts",
];

function isCliCommandName(node, rel) {
  if (rel !== "src/cli/commands.ts" || !isPropertyAssignment(node.parent)) return false;
  const propertyName = node.parent.name;
  if (!(isIdentifier(propertyName) || isStringLiteral(propertyName))
      || propertyName.text !== "name") return false;

  const command = node.parent.parent;
  if (!isObjectLiteralExpression(command) || !isArrayLiteralExpression(command.parent)) {
    return false;
  }
  const array = command.parent;
  const initializer = isAsExpression(array.parent) ? array.parent : array;
  const declaration = initializer.parent;
  return isVariableDeclaration(declaration)
    && isIdentifier(declaration.name)
    && declaration.name.text === "CLI_COMMANDS";
}

function isInlineChannel(value, node, rel) {
  return value.startsWith("lvis:")
    || (value.startsWith("marketplace:") && !isCliCommandName(node, rel))
    || value.startsWith("window:");
}

function staticText(node) {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (isTemplateExpression(node)) return node.head.text;
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

let violations = 0;
const targets = [];
for (const rel of TARGETS) {
  const abs = join(ROOT, rel);
  try {
    targets.push({ rel, abs, content: readFileSync(abs, "utf8") });
  } catch (err) {
    console.error(`[no-inline-channels] cannot read ${rel}: ${err.message}`);
    process.exit(1);
  }
}
const sources = parseSourceFiles(targets.map((target) => target.abs));
for (const { rel, abs, content } of targets) {
  const source = sources.get(abs);
  if (!source) {
    console.error(`[no-inline-channels] cannot parse ${rel}`);
    process.exit(1);
  }
  const lines = content.split("\n");
  const visit = (node) => {
    const value = staticText(node);
    if (value !== undefined && isInlineChannel(value, node, rel)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      console.error(
        `[no-inline-channels] ${rel}:${line + 1} inline channel literal — use CHANNELS.* from src/contract/`,
      );
      console.error(`    ${lines[line]?.trim() ?? ""}`);
      violations += 1;
    }
    node.forEachChild(visit);
  };
  visit(source);
}

if (violations > 0) {
  console.error(
    `[no-inline-channels] FAIL — ${violations} inline channel literal(s); route them through src/contract/app-contract.ts`,
  );
  process.exit(1);
}
console.log("[no-inline-channels] OK");
