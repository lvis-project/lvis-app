#!/usr/bin/env node
/**
 * check-sot-shapes.mjs — single-source-of-truth shape gate
 *
 * Three behaviours in this tree each have one home, chosen after their copies
 * had drifted apart and the drift had cost a defect:
 *
 *   - `rename()` / `renameSync()`: the atomic-replace and lock-retry helpers in
 *     `src/lib/atomic-file.ts`, `src/lib/transient-fs-lock-retry.ts` and the
 *     per-feature storage in `src/main/storage/feature-namespace.ts`. A bare
 *     rename elsewhere is a durability decision made a second time.
 *   - `homedir()` + `startsWith("~")`: `src/shared/home-tilde.ts`. The
 *     permission layer and the tool that opens the file must expand `~` the
 *     same way or they judge and touch different files.
 *   - `x instanceof Error ? x.message : String(x)`: `src/shared/error-message.ts`.
 *
 * A grep is enough to see a new copy appear, and this script is that grep,
 * run as a gate. The copies that existed when the gate was written are held
 * in `sot-shapes-baseline.json` per file, per shape, as a count. The gate
 * fails when any file's count rises or a file without an entry gains a hit —
 * a new copy — and it also fails when a count falls, so the ledger is
 * re-written (`--update-baseline`) rather than left describing copies that
 * are gone. The update refuses to record growth: the baseline only shrinks.
 *
 * Comment-only lines are not counted; prose that names the shape is not a
 * copy of it. Test trees are not scanned: a test may spell the shape out to
 * prove the home handles it.
 */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonFile, writeKnipBaselineAtomicSync } from "./lib/knip-baseline.mjs";
import { walkSourceFiles } from "./lib/source-walk.mjs";

export const SOT_SHAPES_BASELINE_SCHEMA_VERSION = 1;

const SCAN_SKIP_DIRS = new Set(["__tests__", "__mocks__", "__probes__", "node_modules"]);
const TEST_FILE_RE = /\.(?:test|spec)\.(?:ts|tsx)$/;
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * Each shape: the line pattern, the files that are its home (never counted),
 * and an optional file-level precondition — the tilde shape is only a copy of
 * `home-tilde.ts` when the file also resolves the home directory itself.
 */
export const SOT_SHAPES = Object.freeze([
  {
    id: "fs-rename",
    summary: "rename()/renameSync() outside the atomic-file and feature-namespace helpers",
    line: /\b(?:renameSync|rename)\(/,
    homes: [
      "src/lib/atomic-file.ts",
      "src/lib/transient-fs-lock-retry.ts",
      "src/main/storage/feature-namespace.ts",
    ],
  },
  {
    id: "home-tilde",
    summary: 'homedir() + startsWith("~") outside shared/home-tilde.ts',
    line: /startsWith\(["'`]~/,
    file: /\bhomedir\(/,
    homes: ["src/shared/home-tilde.ts"],
  },
  {
    id: "error-message",
    summary: "`instanceof Error ? x.message : String(x)` outside shared/error-message.ts",
    line: /instanceof Error \? [A-Za-z_$][\w$.]*\.message : String\(/,
    homes: ["src/shared/error-message.ts"],
  },
]);

function toPosix(path) {
  return path.split("\\").join("/");
}

/**
 * Count every shape's hits per file under `<root>/src`.
 * @returns {Record<string, Record<string, number>>} shape id → repo-relative file → count
 */
export function scanSotShapes(root, shapes = SOT_SHAPES) {
  const counts = Object.fromEntries(shapes.map((shape) => [shape.id, {}]));
  const files = walkSourceFiles(resolve(root, "src"), {
    skipDirs: SCAN_SKIP_DIRS,
    extensions: [".ts", ".tsx"],
    accept: (path) => !TEST_FILE_RE.test(path),
  });
  for (const path of files) {
    const rel = toPosix(relative(root, path));
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n");
    for (const shape of shapes) {
      if (shape.homes.includes(rel)) continue;
      if (shape.file && !shape.file.test(content)) continue;
      let hits = 0;
      for (const line of lines) {
        if (COMMENT_LINE_RE.test(line)) continue;
        if (shape.line.test(line)) hits += 1;
      }
      if (hits > 0) counts[shape.id][rel] = hits;
    }
  }
  return counts;
}

/**
 * @returns {{ grown: string[]; shrunk: string[] }} human-readable lines.
 * `grown` is a regression; `shrunk` is a stale ledger.
 */
export function compareSotShapes(current, baseline) {
  const grown = [];
  const shrunk = [];
  for (const [id, files] of Object.entries(current)) {
    const recorded = baseline[id] ?? {};
    for (const [file, count] of Object.entries(files)) {
      const was = recorded[file] ?? 0;
      if (count > was) grown.push(`${id} ${file}: ${was} -> ${count}`);
      else if (count < was) shrunk.push(`${id} ${file}: ${was} -> ${count}`);
    }
    for (const [file, was] of Object.entries(recorded)) {
      if (!(file in files)) shrunk.push(`${id} ${file}: ${was} -> 0`);
    }
  }
  return { grown, shrunk };
}

export function formatSotShapesBaseline(counts) {
  const shapes = {};
  for (const id of Object.keys(counts).sort()) {
    shapes[id] = Object.fromEntries(
      Object.entries(counts[id]).sort(([left], [right]) => left.localeCompare(right, "en")),
    );
  }
  return `${JSON.stringify({ schemaVersion: SOT_SHAPES_BASELINE_SCHEMA_VERSION, shapes }, null, 2)}\n`;
}

function totals(counts) {
  return Object.entries(counts)
    .map(([id, files]) => {
      const hits = Object.values(files).reduce((sum, count) => sum + count, 0);
      return `${id}=${hits} hits/${Object.keys(files).length} files`;
    })
    .join(", ");
}

export function runSotShapesGate({ root, baselinePath, updateBaseline, stdout, stderr }) {
  const current = scanSotShapes(root);
  let baseline;
  try {
    baseline = readJsonFile(baselinePath, "sot-shapes-baseline.json");
  } catch (error) {
    if (!updateBaseline) throw error;
    // The first write is the only one that records copies: everything the
    // scan finds is grandfathered once, and shrinks from there.
    writeKnipBaselineAtomicSync(baselinePath, formatSotShapesBaseline(current));
    stdout(`[sot-shapes] baseline written: ${totals(current)}`);
    return 0;
  }
  if (baseline.schemaVersion !== SOT_SHAPES_BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `sot-shapes-baseline.json schema ${baseline.schemaVersion} is not ${SOT_SHAPES_BASELINE_SCHEMA_VERSION}`,
    );
  }
  const { grown, shrunk } = compareSotShapes(current, baseline.shapes ?? {});

  if (grown.length > 0) {
    stderr(`[sot-shapes] FAIL — new copies of a single-source shape:`);
    for (const line of grown) stderr(`  ${line}`);
    for (const shape of SOT_SHAPES) {
      if (grown.some((line) => line.startsWith(`${shape.id} `))) {
        stderr(`  ${shape.id}: ${shape.summary}; use ${shape.homes.join(" / ")}`);
      }
    }
    stderr("  The baseline only shrinks: route the new call through the home instead.");
    return 1;
  }
  if (shrunk.length > 0) {
    if (updateBaseline) {
      writeKnipBaselineAtomicSync(baselinePath, formatSotShapesBaseline(current));
      stdout(`[sot-shapes] baseline updated (${shrunk.length} entries shrank): ${totals(current)}`);
      return 0;
    }
    stderr("[sot-shapes] FAIL — the ledger names copies that are gone; run `bun run check:sot-shapes:update`:");
    for (const line of shrunk) stderr(`  ${line}`);
    return 1;
  }
  stdout(`[sot-shapes] baseline held: ${totals(current)}`);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.exitCode = runSotShapesGate({
    root,
    baselinePath: resolve(root, "sot-shapes-baseline.json"),
    updateBaseline: process.argv.includes("--update-baseline"),
    stdout: console.log,
    stderr: console.error,
  });
}
