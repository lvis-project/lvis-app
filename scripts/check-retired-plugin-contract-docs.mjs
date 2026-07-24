#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
let failed = false;

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function fail(message) {
  failed = true;
  console.error(`[retired-plugin-contract-docs] ${message}`);
}

function requireText(relativePath, text) {
  if (!read(relativePath).includes(text)) {
    fail(`${relativePath}: missing required current-contract text: ${text}`);
  }
}

function rejectPattern(relativePath, pattern, label) {
  if (pattern.test(read(relativePath))) {
    fail(`${relativePath}: contains retired active-contract claim: ${label}`);
  }
}

const legacyParallelShape = /\b(?:uiTool|uiTools|uiAction|uiActions|toolSchemas)\b/;
const explicitLegacyContext = /\b(?:removed|retired|rejects?|legacy|pre-v6|historical|deleted|eliminated|no longer)\b|(?:삭제|제거|거부|대체|통합|legacy)/i;

function isAllowedLegacyParallelShapeLine(line) {
  return !legacyParallelShape.test(line) || explicitLegacyContext.test(line);
}

function rejectUncontextualizedLegacyParallelShapes(relativePath) {
  const lines = read(relativePath).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!legacyParallelShape.test(line)) continue;
    const context = lines.slice(Math.max(0, index - 1), index + 2).join(" ");
    if (!isAllowedLegacyParallelShapeLine(context)) {
      fail(`${relativePath}:${index + 1}: legacy parallel Tool shape lacks removed/rejected context`);
    }
  }
}

function runGuardFixtures() {
  const fixtures = [
    ["The legacy `toolSchemas` map is removed.", true],
    ["The `uiActions` map was deleted in pre-v6.", true],
    ["Use toolSchemas to route a Tool at runtime.", false],
    ["uiAction selects the app-callable surface.", false],
  ];
  for (const [line, expected] of fixtures) {
    if (isAllowedLegacyParallelShapeLine(line) !== expected) {
      throw new Error(`guard fixture failed: ${line}`);
    }
  }
}

if (process.argv.includes("--self-test")) {
  runGuardFixtures();
  console.log("[retired-plugin-contract-docs] self-test OK");
  process.exit(0);
}

runGuardFixtures();

const activeContractSources = [
  "CONTRIBUTING.md",
  "docs/architecture/architecture.md",
  "docs/development/tool-level-deferral-design.md",
  "docs/development/tool-loading-policy.md",
  "docs/guides/plugin-development.md",
  "docs/references/plugin-tool-schema-design.md",
  "docs/ko/architecture/README.md",
  "docs/ko/architecture/plugin-deployment-model.md",
  "docs/ko/development/tool-level-deferral-design.md",
  "docs/ko/development/tool-loading-policy.md",
  "docs/ko/guides/local-plugin-development.md",
  "docs/ko/guides/plugin-development.md",
  "src/tools/registry.ts",
  "src/tools/__tests__/registry-model-exposure.test.ts",
  "web/app/docs/architecture/host-api/page.tsx",
  "web/app/docs/host/skills/page.tsx",
  "web/app/en/docs/architecture/host-api/page.tsx",
  "web/app/en/docs/host/skills/page.tsx",
  "web/components/docs/diagrams.tsx",
  "web/lib/search-index.ts",
  "web/lib/search-index.en.ts",
];

for (const relativePath of activeContractSources) {
  rejectPattern(relativePath, /\bKeyword Engine\b/i, "Keyword Engine");
  rejectPattern(relativePath, /\bKeyword Registry\b/i, "Keyword Registry");
  rejectPattern(relativePath, /keyword[- ]preload(?:ed)?/i, "keyword preload");
  rejectPattern(relativePath, /\bregisterKeywords\b/, "registerKeywords identifier");
  rejectPattern(relativePath, /register(?:ed|ing)? (?:Skill )?keywords?/i, "keyword registration");
  rejectPattern(relativePath, /키워드\s*(?:엔진|레지스트리|프리로드|등록)/, "keyword engine/registry/preload/registration");
  rejectPattern(relativePath, /(?:plugin|Skill) keyword (?:routing|route)/i, "plugin keyword routing");
  rejectPattern(relativePath, /Keyword-based auto recommendation/i, "keyword-based Skill recommendation");
}

for (const relativePath of [
  "docs/guides/plugin-development.md",
  "docs/references/plugin-tool-schema-design.md",
  "docs/ko/guides/local-plugin-development.md",
  "docs/ko/guides/plugin-development.md",
]) {
  rejectUncontextualizedLegacyParallelShapes(relativePath);
}

for (const relativePath of [
  "web/app/docs/host/skills/page.tsx",
  "web/app/en/docs/host/skills/page.tsx",
  "web/app/docs/architecture/host-api/page.tsx",
  "web/app/en/docs/architecture/host-api/page.tsx",
]) {
  requireText(relativePath, "tool_search");
}

requireText("docs/architecture/architecture.md", "manifest.skills");
requireText("docs/architecture/architecture.md", "tool_search");
requireText("docs/guides/plugin-development.md", "tool_search");
requireText("docs/references/plugin-tool-schema-design.md", "tool_search");
requireText("docs/development/tool-loading-policy.md", "Natural-language text never selects a Tool");
requireText("docs/ko/development/tool-loading-policy.md", "Natural-language text never selects a Tool");
requireText("docs/architecture/plugin-contract-v6-design.md", "The `uiActions` map is **eliminated**");
requireText("docs/architecture/plugin-contract-v6-design.md", "`toolSchemas` map and `uiActions` map are **deleted**");
requireText("docs/ko/architecture/architecture.md", "Historical snapshot");
requireText("docs/architecture/mcp-alignment-design.md", "Historical design record");
requireText("docs/ko/architecture/mcp-alignment-design.md", "Historical design record");

if (failed) process.exit(1);
console.log("[retired-plugin-contract-docs] OK");
