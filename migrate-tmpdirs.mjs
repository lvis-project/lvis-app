#!/usr/bin/env node
/**
 * Migrate 33 test files from ~/.lvis/test-tmp to os.tmpdir().
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WORKTREE = "C:\\Users\\ikcha\\workspace\\lvis-project\\_test-hygiene";

const files = [
  "src/audit/__tests__/audit-rotation.test.ts",
  "src/audit/__tests__/audit-search.test.ts",
  "src/boot/__tests__/capability-audit-trail.test.ts",
  "src/boot/__tests__/event-hints.test.ts",
  "src/boot/__tests__/phase5-event-namespace.test.ts",
  "src/data/__tests__/settings-store.test.ts",
  "src/engine/__tests__/conversation-trace.test.ts",
  "src/engine/__tests__/usage-stats.test.ts",
  "src/hooks/__tests__/config-loader.test.ts",
  "src/lib/__tests__/with-file-lock.test.ts",
  "src/main/__tests__/release-prep.test.ts",
  "src/mcp/__tests__/mcp-marketplace-install.test.ts",
  "src/memory/__tests__/search.test.ts",
  "src/plugins/__tests__/deployment-guard.test.ts",
  "src/plugins/__tests__/destructive-uicallable-guard.test.ts",
  "src/plugins/__tests__/entry-path-guard.test.ts",
  "src/plugins/__tests__/marketplace-dependency-guard.test.ts",
  "src/plugins/__tests__/marketplace-guard.test.ts",
  "src/plugins/__tests__/marketplace-installer.test.ts",
  "src/plugins/__tests__/offline-cache.test.ts",
  "src/plugins/__tests__/phase5-validation.test.ts",
  "src/plugins/__tests__/plugin-artifact-store.test.ts",
  "src/plugins/__tests__/plugin-cards.test.ts",
  "src/plugins/__tests__/reload.test.ts",
  "src/plugins/__tests__/rollback.test.ts",
  "src/plugins/__tests__/runtime-config-overrides.test.ts",
  "src/plugins/__tests__/runtime.test.ts",
  "src/plugins/__tests__/signature-verifier.test.ts",
  "src/plugins/__tests__/sprint4b-ajv-guards.test.ts",
  "src/plugins/__tests__/sprint4b-signature-enforcement.test.ts",
  "src/plugins/__tests__/update-detector.test.ts",
  "src/sandbox/__tests__/path-validator.test.ts",
  "src/__tests__/telemetry-client.test.ts",
];

/** Add `tmpdir` to the node:os import line */
function addTmpdirToOsImport(content) {
  const osImportRe = /import\s*\{([^}]+)\}\s*from\s*"node:os"/;
  const m = osImportRe.exec(content);
  if (m) {
    const imports = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (!imports.includes("tmpdir")) {
      imports.push("tmpdir");
      imports.sort();
      return content.replace(m[0], `import { ${imports.join(", ")} } from "node:os"`);
    }
    return content;
  }
  // No node:os import — add one after the last import line
  const lines = content.split("\n");
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s/.test(lines[i])) lastImportIdx = i;
  }
  if (lastImportIdx >= 0) {
    lines.splice(lastImportIdx + 1, 0, 'import { tmpdir } from "node:os";');
    return lines.join("\n");
  }
  return 'import { tmpdir } from "node:os";\n' + content;
}

/** Remove homedir from node:os import if no longer used (outside import lines) */
function removeHomedirIfUnused(content) {
  const osImportRe = /import\s*\{([^}]+)\}\s*from\s*"node:os"/;
  const m = osImportRe.exec(content);
  if (!m) return content;

  const imports = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  if (!imports.includes("homedir")) return content;

  // Remove the import statement text and check remaining usage
  const withoutImport = content.replace(m[0], "");
  if (/\bhomedir\b/.test(withoutImport)) return content; // still used

  // Remove homedir from import
  const remaining = imports.filter((i) => i !== "homedir");
  if (remaining.length > 0) {
    return content.replace(m[0], `import { ${remaining.join(", ")} } from "node:os"`);
  } else {
    // Remove entire import line (including trailing newline)
    return content.replace(m[0] + ";", "").replace(/\n\n+/g, "\n\n");
  }
}

/** Ensure mkdtempSync is in the node:fs import */
function ensureMkdtempSync(content) {
  const fsImportRe = /import\s*\{([^}]+)\}\s*from\s*"node:fs"/;
  const m = fsImportRe.exec(content);
  if (m) {
    const imports = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (!imports.includes("mkdtempSync")) {
      imports.push("mkdtempSync");
      imports.sort();
      return content.replace(m[0], `import { ${imports.join(", ")} } from "node:fs"`);
    }
    return content;
  }
  // No node:fs import — add one
  const lines = content.split("\n");
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s/.test(lines[i])) lastImportIdx = i;
  }
  if (lastImportIdx >= 0) {
    lines.splice(lastImportIdx + 1, 0, 'import { mkdtempSync } from "node:fs";');
    return lines.join("\n");
  }
  return 'import { mkdtempSync } from "node:fs";\n' + content;
}

function migrateFile(filepath) {
  const original = readFileSync(filepath, "utf-8");
  let content = original;
  const changes = [];
  let needsMkdtempSyncImport = false;

  // ── Pattern A: mkdtempSync(join(homedir(), ".lvis", "test-tmp", "string-prefix"))
  // → mkdtempSync(join(tmpdir(), "string-prefix"))
  {
    const re = /mkdtempSync\(join\(homedir\(\),\s*"\.lvis",\s*"test-tmp",\s*("([^"]+)")\)\)/g;
    if (re.test(content)) {
      content = content.replace(
        /mkdtempSync\(join\(homedir\(\),\s*"\.lvis",\s*"test-tmp",\s*("([^"]+)")\)\)/g,
        (_, quoted) => `mkdtempSync(join(tmpdir(), ${quoted}))`
      );
      changes.push("Pattern A: mkdtempSync(join(homedir, .lvis, test-tmp, string))");
    }
  }

  // ── Pattern B/G: var = join(homedir(), ".lvis", "test-tmp", `prefix-${expr}`)
  // → var = mkdtempSync(join(tmpdir(), "prefix-"))
  // Capture the static prefix part before the first ${ interpolation
  {
    const re = /((?:testHome|testDir|tmpDir)\s*=\s*)join\(homedir\(\),\s*"\.lvis",\s*"test-tmp",\s*`([^`$]+)\$\{[^`]+\}`\);/g;
    if (re.test(content)) {
      content = content.replace(
        /((?:testHome|testDir|tmpDir)\s*=\s*)join\(homedir\(\),\s*"\.lvis",\s*"test-tmp",\s*`([^`$]+)\$\{[^`]+\}`\);/g,
        (_, assign, prefix) => {
          changes.push(`Pattern B/G: dynamic join, prefix="${prefix}"`);
          needsMkdtempSyncImport = true;
          return `${assign}mkdtempSync(join(tmpdir(), "${prefix}"));`;
        }
      );
    }
  }

  // ── Pattern C: const root = join(homedir(), ".lvis", "test-tmp");
  // → const root = tmpdir();
  {
    const re = /(const\s+root\s*=\s*)join\(homedir\(\),\s*"\.lvis",\s*"test-tmp"\);/g;
    if (re.test(content)) {
      content = content.replace(
        /(const\s+root\s*=\s*)join\(homedir\(\),\s*"\.lvis",\s*"test-tmp"\);/g,
        (_, assign) => {
          changes.push("Pattern C: const root = join(homedir, .lvis, test-tmp)");
          return `${assign}tmpdir();`;
        }
      );
    }
  }

  // ── Pattern D: const root = join(homedir(), ".lvis", "test-tmp", "a", "b", ...)
  // → const root = join(tmpdir(), "a", "b", ...)
  {
    const re = /(const\s+\w+\s*=\s*)join\(homedir\(\),\s*"\.lvis",\s*"test-tmp",\s*("(?:[^"]+)"(?:,\s*"[^"]*")*)\);/g;
    if (re.test(content)) {
      content = content.replace(
        /(const\s+\w+\s*=\s*)join\(homedir\(\),\s*"\.lvis",\s*"test-tmp",\s*("(?:[^"]+)"(?:,\s*"[^"]*")*)\);/g,
        (_, assign, suffixes) => {
          changes.push(`Pattern D: const with suffix join(homedir, .lvis, test-tmp, ${suffixes})`);
          return `${assign}join(tmpdir(), ${suffixes});`;
        }
      );
    }
  }

  // ── Pattern E: remove redundant mkdirSync(join(homedir(), ".lvis", "test-tmp"), {...})
  {
    const re = /[ \t]*mkdirSync\(join\(homedir\(\),\s*"\.lvis",\s*"test-tmp"\),\s*\{[^}]+\}\);\n?/g;
    if (re.test(content)) {
      content = content.replace(
        /[ \t]*mkdirSync\(join\(homedir\(\),\s*"\.lvis",\s*"test-tmp"\),\s*\{[^}]+\}\);\n?/g,
        ""
      );
      changes.push("Pattern E: removed redundant mkdirSync");
    }
  }

  // ── Pattern F: any remaining join(homedir(), ".lvis", "test-tmp", `template`)
  // (for telemetry-client property value)
  {
    const re = /join\(homedir\(\),\s*"\.lvis",\s*"test-tmp",\s*(`[^`]+`)\)/g;
    if (re.test(content)) {
      content = content.replace(
        /join\(homedir\(\),\s*"\.lvis",\s*"test-tmp",\s*(`[^`]+`)\)/g,
        (_, tpl) => {
          changes.push(`Pattern F: inline template join → join(tmpdir(), ${tpl.slice(0, 40)})`);
          return `join(tmpdir(), ${tpl})`;
        }
      );
    }
  }

  // ── Remove "await mkdir(testDir/tmpDir/testHome, { recursive: true });"
  // lines that are now redundant because mkdtempSync creates the directory
  for (const varName of ["testDir", "tmpDir", "testHome"]) {
    const escapedVar = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Only remove if this var was migrated to mkdtempSync
    if (new RegExp(escapedVar + `\\s*=\\s*mkdtempSync\\(`).test(content)) {
      const rmRe = new RegExp(`[ \\t]*await mkdir\\(${escapedVar},\\s*\\{\\s*recursive:\\s*true\\s*\\}\\);\\n`, "g");
      if (rmRe.test(content)) {
        content = content.replace(rmRe, "");
        changes.push(`Removed await mkdir(${varName}) — mkdtempSync creates it`);
      }
    }
  }

  // ── Fix imports ──────────────────────────────────────────────────────────────
  if (content !== original) {
    content = addTmpdirToOsImport(content);
    content = removeHomedirIfUnused(content);
    if (needsMkdtempSyncImport) {
      // Check if mkdtempSync is already imported
      if (!/import\s*\{[^}]*mkdtempSync[^}]*\}\s*from\s*"node:fs"/.test(content)) {
        content = ensureMkdtempSync(content);
        changes.push("Added mkdtempSync to node:fs import");
      }
    }
  }

  return { content, original, changes };
}

let totalChanged = 0;
const warnings = [];

for (const relPath of files) {
  const fullPath = join(WORKTREE, relPath);
  if (!existsSync(fullPath)) {
    console.log(`MISSING: ${relPath}`);
    continue;
  }

  const { content, original, changes } = migrateFile(fullPath);

  if (content !== original) {
    writeFileSync(fullPath, content, "utf-8");
    totalChanged++;
    console.log(`CHANGED: ${relPath}`);
    for (const c of changes) console.log(`  - ${c}`);
  } else {
    console.log(`NO CHANGE: ${relPath}`);
  }

  // Check for remaining patterns
  const remaining = /join\(homedir\(\),\s*"\.lvis",\s*"test-tmp"/.exec(content);
  if (remaining) {
    const lineNum = content.slice(0, remaining.index).split("\n").length;
    const snippet = content.slice(remaining.index, remaining.index + 80).replace(/\n/g, "\\n");
    const msg = `  !! REMAINING PATTERN at line ${lineNum}: ${snippet}`;
    console.log(msg);
    warnings.push(`${relPath}:${lineNum}`);
  }
}

console.log(`\nTotal files changed: ${totalChanged}`);
if (warnings.length > 0) {
  console.log(`\nWARNINGS — remaining patterns in:`);
  warnings.forEach((w) => console.log(`  ${w}`));
  process.exit(1);
}
