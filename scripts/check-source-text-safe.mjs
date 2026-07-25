#!/usr/bin/env node
/**
 * check-source-text-safe.mjs — keep every source file readable by diff and search.
 *
 * A raw control byte inside a source file (typically written by accident into a
 * regex character class, e.g. `/[<NUL>-<0x1f>]/` instead of the escape text) is
 * valid JavaScript and runs correctly, so nothing catches it. What it breaks is the
 * machinery AROUND the code:
 *
 *   - git auto-detects a NUL in the first 8 KB as binary, so `git diff` prints
 *     "Binary files differ" and the file becomes invisible in review — including in
 *     the cluster-review gate this repo depends on for sensitive areas;
 *   - ripgrep skips it, so the file cannot be found from a symbol it defines;
 *   - `.github/workflows/naming-gate.yml` scans `git diff … | grep -E "^\+"`, which
 *     yields nothing for a binary file, exempting it from that gate entirely.
 *
 * This happened twice in one review cycle, both times to the module defining a
 * shared validation predicate — the most review-sensitive kind of file. Hence a
 * gate rather than a convention: write control characters as escape TEXT
 * (`\u0000`, `\x1f`), which reads identically to the regex engine.
 *
 * TAB, LF, and CR are allowed (ordinary formatting). Run standalone with
 * `node scripts/check-source-text-safe.mjs`; the scanner is exported so
 * `test/scripts/source-text-safe.test.mjs` can exercise it against fixtures.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOTS = ["src", "scripts", "test"];
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json", ".css"];
const ALLOWED_BYTES = new Set([0x09, 0x0a, 0x0d]);
/** Report at most this many byte positions per file — enough to locate the cause. */
const MAX_HITS_PER_FILE = 4;

/**
 * Files that already carried raw control bytes before this gate existed. They are
 * test fixtures and one dialog, not enforcement code, so they are recorded rather
 * than rewritten — but the list may only SHRINK, which the scanner enforces: a
 * listed file that is now clean is reported as stale. Otherwise this set becomes
 * the obvious place to silence a future offender.
 */
const GRANDFATHERED = [
  "src/mcp/__tests__/mcp-app-download.test.ts",
  "src/shared/__tests__/mcp-app-partition.test.ts",
  "src/ui/renderer/components/ToolApprovalDialog.tsx",
];

function listFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      listFiles(full, out);
    } else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function controlByteHits(bytes) {
  const hits = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if ((byte < 0x20 && !ALLOWED_BYTES.has(byte)) || byte === 0x7f) hits.push([i, byte]);
    if (hits.length >= MAX_HITS_PER_FILE) break;
  }
  return hits;
}

/**
 * Scan `roots` (relative to `repoRoot`) and split the result into files that must be
 * fixed and grandfathered entries that are now clean.
 */
export function scanSourceTextSafety(repoRoot, roots = ROOTS, grandfathered = GRANDFATHERED) {
  const exempt = new Set(grandfathered);
  const offenders = [];
  const stale = [];
  for (const root of roots) {
    for (const file of listFiles(resolve(repoRoot, root))) {
      const rel = relative(repoRoot, file).split("\\").join("/");
      const hits = controlByteHits(readFileSync(file));
      if (hits.length === 0) {
        if (exempt.has(rel)) stale.push(rel);
        continue;
      }
      if (exempt.has(rel)) continue;
      const where = hits
        .map(([offset, byte]) => `offset ${offset} = 0x${byte.toString(16).padStart(2, "0")}`)
        .join(", ");
      offenders.push(`${rel}: ${where}`);
    }
  }
  return { offenders, stale };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { offenders, stale } = scanSourceTextSafety(resolve(import.meta.dirname, ".."));

  if (stale.length > 0) {
    console.error(
      "[source-text-safe] FAIL — these files no longer contain raw control bytes and\n"
        + "must be removed from GRANDFATHERED in this script:\n"
        + stale.map((line) => `  ${line}`).join("\n"),
    );
    process.exit(1);
  }

  if (offenders.length > 0) {
    console.error(
      "[source-text-safe] FAIL — raw control bytes in source. Git may treat the file as\n"
        + "binary, which hides it from diffs, review, ripgrep, and the naming gate.\n"
        + "Write the character as escape TEXT instead (\\u0000, \\x1f, \\u007f).\n"
        + offenders.map((line) => `  ${line}`).join("\n"),
    );
    process.exit(1);
  }

  console.log("[source-text-safe] OK");
}
