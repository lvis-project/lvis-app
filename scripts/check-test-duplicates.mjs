import { readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  isArrowFunction,
  isCallExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isSourceFile,
  isVariableDeclaration,
} from "typescript/unstable/ast";
import { parseSourceFiles } from "./lib/ts7-ast.mjs";

const ROOT = process.cwd();

const SKIP_DIRS = new Set([
  ".git",
  // Agent worktrees (`.claude/worktrees/**` and `.worktrees/**`) are transient
  // checkouts of this very
  // repo — scanning them reports every helper as a 2-3x "duplicate" of itself, and
  // they never exist in CI's clean checkout. Skip so a local run matches CI.
  ".claude",
  ".worktrees",
  "coverage",
  "dist",
  "node_modules",
  "release-staging",
]);

const TEST_SOURCE_FILE_RE = /\.(?:test|spec)\.(?:ts|tsx|mts|mjs|js)$/;
const JS_TS_FILE_RE = /\.(?:ts|tsx|mts|mjs|js)$/;
const TEST_HELPER_FILE_RE =
  /(?:^|[-_])(?:test-)?helpers?\.(?:ts|tsx|mts|mjs|js)$/;
const TEST_FIXTURE_FILE_RE =
  /(?:^|[-_])(?:fixtures?|fixture-support|mock-server|fake-[A-Za-z0-9_-]+)\.(?:ts|tsx|mts|mjs|js)$/;
const SHARED_RENDERER_MOCK_FILE_RE = /^mock-lvis-api\.(?:ts|tsx|mts|mjs|js)$/;
const TEST_SUPPORT_PATH_RE = /(?:^|\/)(?:test|__tests__|fixtures)(?:\/|$)/;
const HELPER_NAME_RE =
  /^(?:make|create|write|setup|fixture|mock|fake|stub|build)[A-Z_][A-Za-z0-9_]*$/;
/**
 * Floor for the advisory name-hotspot path and for same-file pairs ONLY. A
 * helper name repeated across files is worth reporting when its body is
 * substantial or its name says "fixture"; it is noise for a two-line `ctx()`.
 * The cross-file exact-body path is not gated by this — it was, and six groups
 * of identical 40-character helpers went unreported while the gate printed 0.
 */
const MIN_GENERAL_HELPER_BODY_LENGTH = 80;
const IGNORED_HELPER_NAMES = new Set([
  "setup",
  "fixture",
  "mock",
]);

export function normalizeRepoPath(filePath, root = ROOT) {
  const relativePath = relative(root, filePath);
  const isOutsideRoot = relativePath.startsWith("..") || relativePath === "";
  return (isOutsideRoot ? filePath : relativePath).split("\\").join("/");
}

export function isScannedTestSource(filePath, root = ROOT) {
  const normalizedPath = normalizeRepoPath(filePath, root);
  const fileName = basename(normalizedPath);
  if (!JS_TS_FILE_RE.test(fileName)) return false;
  const isBareFileName = !normalizedPath.includes("/");
  const isTestSupportPath = TEST_SUPPORT_PATH_RE.test(normalizedPath);
  return (
    TEST_SOURCE_FILE_RE.test(fileName) ||
    SHARED_RENDERER_MOCK_FILE_RE.test(fileName) ||
    (isBareFileName && (TEST_HELPER_FILE_RE.test(fileName) || TEST_FIXTURE_FILE_RE.test(fileName))) ||
    isTestSupportPath
  );
}

export function walk(dir, out = [], root = ROOT) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out, root);
      continue;
    }
    const filePath = join(dir, entry.name);
    if (isScannedTestSource(filePath, root)) out.push(filePath);
  }
  return out;
}

export function collectHelpers(files, root = ROOT) {
  const byName = new Map();
  const byBody = new Map();
  const sources = parseSourceFiles(files);
  for (const file of files) {
    const sourceFile = sources.get(file);
    if (!sourceFile) continue;
    const rel = relative(root, file);
    const visit = (node) => {
      const helper = getHelperNode(node);
      if (!helper) {
        node.forEachChild(visit);
        return;
      }
      const { name, body } = helper;
      if (!name) {
        node.forEachChild(visit);
        return;
      }
      const normalizedBody = normalizeHelperBody(body.getText(sourceFile));
      if (!normalizedBody) {
        node.forEachChild(visit);
        return;
      }
      // Exact path: every helper a suite could import instead of redeclaring,
      // whatever its length. Two identical bodies in two FILES are a duplicate
      // whether they are 40 characters or 400; the length floor is only a noise
      // filter for the name-hotspot path and for same-file pairs (see
      // collectDuplicateBodies). What the exact path excludes is structural, not metric:
      // closures nested inside another helper or a test body (a promise
      // executor's `resolve`, a fixture's inner `cleanup`) are that helper's
      // implementation, not something a second suite could share, and a body
      // with no identifier or literal at all (`{}`, `undefined`, `() => {}`)
      // is a placeholder, not a helper.
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const candidate = isHelperCandidate(name, normalizedBody);
      if (isShareableScope(node) && hasSubstance(normalizedBody)) {
        if (!byBody.has(normalizedBody)) byBody.set(normalizedBody, []);
        byBody.get(normalizedBody).push({ name, rel, line, candidate });
      }
      if (candidate) {
        if (!byName.has(name)) byName.set(name, new Set());
        byName.get(name).add(rel);
      }

      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return { byName, byBody };
}

function getHelperNode(node) {
  if (isFunctionDeclaration(node) && node.name && node.body) {
    return { name: node.name.text, body: node.body };
  }
  if (
    isVariableDeclaration(node) &&
    isIdentifier(node.name) &&
    node.initializer &&
    (isArrowFunction(node.initializer) || isFunctionExpression(node.initializer))
  ) {
    return { name: node.name.text, body: node.initializer.body };
  }
  return null;
}

/**
 * A helper another file could import: declared at module scope, or directly
 * inside a `describe` callback (a module-like grouping scope). Anything nested
 * in a test body or in another function is local to that function.
 */
function isShareableScope(node) {
  let current = node.parent;
  while (current && !isSourceFile(current)) {
    if (isFunctionLikeDeclaration(current)) {
      const call = current.parent;
      const isDescribeCallback =
        call &&
        isCallExpression(call) &&
        isIdentifier(call.expression) &&
        call.expression.text === "describe";
      if (!isDescribeCallback) return false;
    }
    current = current.parent;
  }
  return true;
}

const PLACEHOLDER_TOKENS = new Set(["undefined", "null", "true", "false", "void", "return"]);

/** A body that names something — an identifier, a string, a number — rather than `{}` or a bare literal. */
function hasSubstance(normalizedBody) {
  const tokens = normalizedBody.match(/[A-Za-z_$][A-Za-z0-9_$]*|"[^"]*"|'[^']*'|`[^`]*`|\d+/g) ?? [];
  return tokens.some((token) => !PLACEHOLDER_TOKENS.has(token));
}

function isHelperCandidate(name, normalizedBody) {
  if (!normalizedBody) return false;
  if (IGNORED_HELPER_NAMES.has(name)) {
    return normalizedBody.length >= MIN_GENERAL_HELPER_BODY_LENGTH;
  }
  return (
    HELPER_NAME_RE.test(name) ||
    normalizedBody.length >= MIN_GENERAL_HELPER_BODY_LENGTH
  );
}

export function collectDuplicateNames(byName) {
  return [...byName.entries()]
    .filter(([, locations]) => locations.size > 1)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
}

/**
 * Identical bodies across two files are always a finding. Within ONE file they
 * are a finding only when a helper is a candidate by name or size: two short
 * same-file wrappers that differ only in their defaults (`futureIso` /
 * `pastIso`) are one local API, not a copy waiting to be shared.
 */
export function collectDuplicateBodies(byBody) {
  return [...byBody.entries()]
    .map(([body, entries]) => {
      const uniqueLocations = new Set(entries.map((entry) => entry.rel));
      const uniqueNames = new Set(entries.map((entry) => entry.name));
      return { body, entries, uniqueLocations, uniqueNames };
    })
    .filter(
      (group) =>
        group.entries.length > 1 &&
        (group.uniqueLocations.size > 1 || group.entries.some((entry) => entry.candidate)),
    )
    .sort(
      (a, b) =>
        b.entries.length - a.entries.length ||
        b.uniqueLocations.size - a.uniqueLocations.size ||
        [...a.uniqueNames][0].localeCompare([...b.uniqueNames][0]),
    );
}

export function normalizeHelperBody(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function analyzeDuplicateHelpers(root = ROOT) {
  const testFiles = walk(root, [], root);
  const { byName, byBody } = collectHelpers(testFiles, root);
  return {
    files: testFiles,
    duplicateBodies: collectDuplicateBodies(byBody),
    duplicateNames: collectDuplicateNames(byName),
  };
}

function parseLimit(args) {
  return Number.parseInt(
    args.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length) ?? "40",
    10,
  );
}

export function runDuplicateCli(args = process.argv.slice(2), options = {}) {
  const root = options.root ?? ROOT;
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  const failOnDuplicates = args.includes("--fail-on-duplicates");
  const showNameHotspots = args.includes("--name-hotspots");
  const limit = parseLimit(args);
  const { files, duplicateBodies, duplicateNames } = analyzeDuplicateHelpers(root);

  stdout(`test files: ${files.length}`);
  stdout(`duplicate helper implementations: ${duplicateBodies.length}`);
  for (const group of duplicateBodies.slice(0, limit)) {
    stdout(`\n${group.uniqueLocations.size}x ${[...group.uniqueNames].join(" / ")}`);
    for (const entry of group.entries.slice(0, 8)) {
      stdout(`  - ${entry.rel}:${entry.line} (${entry.name})`);
    }
    if (group.entries.length > 8) stdout(`  - ... ${group.entries.length - 8} more`);
  }

  if (showNameHotspots) {
    stdout(`helper-name hotspots (advisory): ${duplicateNames.length}`);
    for (const [name, locations] of duplicateNames.slice(0, limit)) {
      stdout(`\n${locations.size}x ${name}`);
      for (const location of [...locations].slice(0, 8)) {
        stdout(`  - ${location}`);
      }
      if (locations.size > 8) stdout(`  - ... ${locations.size - 8} more`);
    }
  }

  if (failOnDuplicates && duplicateBodies.length > 0) {
    stderr(
      `\nDuplicate test helper implementations remain. Refactor shared fixtures or add a targeted exception only with rationale.`,
    );
    return 1;
  }
  return 0;
}

function main() {
  process.exitCode = runDuplicateCli(process.argv.slice(2), { root: ROOT });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
