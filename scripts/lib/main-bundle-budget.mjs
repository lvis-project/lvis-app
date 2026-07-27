import { isAbsolute, normalize, posix, relative, resolve } from "node:path";

const LEGACY_SINGLE_MAIN_BUNDLE_BYTES = 10_828_547;

/**
 * A growth ratchet, not a target. `entryBytes` and `initialBytes` are the ones that cost
 * the user startup time; `totalBytes` bounds how much the main process can grow overall.
 *
 * Last measured on `main`: entry 1_464_068, initial 5_049_267, total 10_984_203 — i.e.
 * `totalBytes` had 15_797 bytes of headroom, which the MCP resource-template work then
 * spent (+20_980 total, of which only +8_474 is initial). Raised once here rather than
 * trimming, because the growth is functionality reaching main, not weight: the startup
 * numbers still sit ~200 KB and ~240 KB under their own ceilings. Record the new
 * measurement here whenever this line moves, so the next bump argues against a number
 * instead of against a feeling.
 */
export const MAIN_BUNDLE_BUDGETS = Object.freeze({
  entryBytes: 1_700_000,
  initialBytes: 5_250_000,
  totalBytes: 11_050_000,
});

function normalizedPath(path) {
  return normalize(path).replaceAll("\\", "/");
}

function resolveOutputImport(outputPath, importPath, outputKeys) {
  const normalizedImportPath = normalizedPath(importPath);
  const normalizedOutputPath = normalizedPath(outputPath);
  const candidates = [normalizedImportPath];
  if (!isAbsolute(normalizedImportPath)) {
    candidates.push(posix.join(posix.dirname(normalizedOutputPath), normalizedImportPath));
  }
  for (const candidate of candidates) {
    if (outputKeys.has(candidate)) return candidate;
  }
  return null;
}

function outputForEntryPoint(outputs, entryPoint) {
  const normalizedEntryPoint = normalizedPath(entryPoint);
  return [...outputs.entries()].find(([, output]) => {
    if (typeof output.entryPoint !== "string") return false;
    const candidate = normalizedPath(output.entryPoint);
    return candidate === normalizedEntryPoint
      || (!isAbsolute(candidate) && normalizedEntryPoint.endsWith(`/${candidate}`));
  });
}

function outputContainsInput(output, inputPath) {
  const normalizedInputPath = normalizedPath(inputPath);
  return Object.keys(output?.inputs ?? {}).some((path) => {
    const candidate = normalizedPath(path);
    return candidate === normalizedInputPath
      || (!isAbsolute(candidate) && normalizedInputPath.endsWith(`/${candidate}`));
  });
}

export function analyzeMainBundleMetafile(metafile, { entryPoint, requiredAsyncEntryPoint }) {
  if (!metafile || typeof metafile !== "object" || !metafile.outputs) {
    throw new Error("main bundle metafile is missing outputs");
  }

  const outputs = new Map(
    Object.entries(metafile.outputs).map(([path, value]) => [normalizedPath(path), value]),
  );
  const entry = outputForEntryPoint(outputs, entryPoint);
  if (!entry) throw new Error(`main bundle entry output not found for ${entryPoint}`);
  const requiredAsyncEntry = outputForEntryPoint(outputs, requiredAsyncEntryPoint);
  if (!requiredAsyncEntry) {
    throw new Error(`required async entry output not found for ${requiredAsyncEntryPoint}`);
  }

  const outputKeys = new Set(outputs.keys());
  const initial = new Set();
  const pending = [entry[0]];
  let hasRequiredAsyncBoundary = false;
  while (pending.length > 0) {
    const outputPath = pending.pop();
    if (!outputPath || initial.has(outputPath)) continue;
    initial.add(outputPath);
    const output = outputs.get(outputPath);
    for (const imported of output?.imports ?? []) {
      if (imported.external === true) continue;
      const dependency = resolveOutputImport(outputPath, imported.path, outputKeys);
      if (!dependency && (imported.kind === "dynamic-import" || imported.kind === "import-statement")) {
        throw new Error(
          `main bundle import '${imported.path}' from '${outputPath}' has no emitted output`,
        );
      }
      if (dependency === requiredAsyncEntry[0] && imported.kind === "dynamic-import") {
        hasRequiredAsyncBoundary = true;
      }
      if (imported.kind !== "import-statement") continue;
      pending.push(dependency);
    }
  }

  const entryBytes = entry[1].bytes;
  const initialBytes = [...initial]
    .reduce((sum, outputPath) => sum + outputs.get(outputPath).bytes, 0);
  const totalBytes = [...outputs.values()].reduce((sum, output) => sum + output.bytes, 0);
  return {
    entryBytes,
    initialBytes,
    totalBytes,
    asyncBytes: totalBytes - initialBytes,
    initialFiles: initial.size,
    totalFiles: outputs.size,
    hasRequiredAsyncBoundary,
    requiredAsyncEntryIsInitial: initial.has(requiredAsyncEntry[0])
      || [...initial].some((outputPath) => (
        outputContainsInput(outputs.get(outputPath), requiredAsyncEntryPoint)
      )),
    legacyInitialReduction: 1 - (initialBytes / LEGACY_SINGLE_MAIN_BUNDLE_BYTES),
  };
}

export function assertMainBundleBudget(measurement, budgets) {
  const failures = [];
  if (!measurement.hasRequiredAsyncBoundary) {
    failures.push("required boot entry has no async bundle boundary");
  }
  if (measurement.requiredAsyncEntryIsInitial) {
    failures.push("required boot entry remains statically reachable from main");
  }
  for (const key of ["entryBytes", "initialBytes", "totalBytes"]) {
    if (!Number.isFinite(measurement[key]) || measurement[key] < 0) {
      failures.push(`${key} is not a non-negative finite number`);
    } else if (measurement[key] > budgets[key]) {
      failures.push(`${key} ${measurement[key]} exceeds ${budgets[key]}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`main bundle budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }
}

export function formatMainBundleBudget(measurement) {
  const reduction = (measurement.legacyInitialReduction * 100).toFixed(1);
  return [
    "[main-bundle-budget] passed",
    `entry=${measurement.entryBytes}`,
    `initial=${measurement.initialBytes}`,
    `async=${measurement.asyncBytes}`,
    `total=${measurement.totalBytes}`,
    `files=${measurement.initialFiles}/${measurement.totalFiles}`,
    `legacy-initial-reduction=${reduction}%`,
  ].join(" ");
}

export function createMainBundleManifest(metafile, { outdir, absWorkingDir = outdir }) {
  const normalizedOutdir = normalizedPath(outdir);
  const normalizedWorkingDir = normalizedPath(absWorkingDir);
  const files = Object.entries(metafile.outputs)
    .map(([path, output]) => ({
      path: normalizedPath(relative(
        normalizedOutdir,
        isAbsolute(path)
          ? normalizedPath(path)
          : normalizedPath(resolve(normalizedWorkingDir, path)),
      )),
      bytes: output.bytes,
    }))
    .filter((entry) => entry.path !== ".." && !entry.path.startsWith("../"))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (!files.some((entry) => entry.path === "main.js")) {
    throw new Error("main bundle manifest does not contain main.js");
  }
  return {
    schemaVersion: 1,
    entry: "main.js",
    files,
  };
}
