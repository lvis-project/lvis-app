import { dirname, posix } from "node:path";

/** Separately executed child entries that belong to the server artifact. */
export const HEADLESS_CHILD_ENTRY_POINTS = Object.freeze({
  "image-preparation-child": "src/tools/image-preparation-child.ts",
});

function assertServerDependency(owner, dependency) {
  if (dependency === "electron" || dependency.startsWith("electron/") || dependency === "electron-updater" || dependency.startsWith("@sentry/electron")) {
    throw new Error(`headless-desktop-dependency: ${owner} -> ${dependency}`);
  }
}

/** Reject desktop dependencies in both source and emitted lazy-import closures. */
export function assertHeadlessBundleBoundary(metafile, entryPoint = "src/headless.ts", childEntryPoints = []) {
  const entry = Object.keys(metafile.inputs).find((name) => name === entryPoint || name.endsWith(`/${entryPoint}`));
  if (!entry) throw new Error(`headless-entry-missing: ${entryPoint}`);
  const visited = new Set();
  const childEntries = childEntryPoints.map((path) => {
    const input = Object.keys(metafile.inputs).find((name) => name === path || name.endsWith(`/${path}`));
    if (!input) throw new Error(`headless-child-entry-missing: ${path}`);
    return input;
  });
  const pending = [entry, ...childEntries];
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const input = metafile.inputs[current];
    if (!input) throw new Error(`headless-input-missing: ${current}`);
    for (const dependency of input.imports) {
      assertServerDependency(current, dependency.path);
      if (!dependency.external) pending.push(dependency.path);
    }
  }
  const outputEntries = Object.entries(metafile.outputs);
  const outputEntry = outputEntries.find(([, value]) => value.entryPoint === entry);
  if (!outputEntry) throw new Error("headless-output-entry-missing");
  const outputRoot = dirname(outputEntry[0]).replaceAll("\\", "/");
  const outputs = new Map(outputEntries);
  const outputVisited = new Set();
  const external = new Set();
  const childOutputs = childEntries.map((child) => {
    const output = outputEntries.find(([, value]) => value.entryPoint === child);
    if (!output) throw new Error(`headless-child-output-missing: ${child}`);
    return output[0];
  });
  const outputPending = [outputEntry[0], ...childOutputs];
  while (outputPending.length > 0) {
    const current = outputPending.pop();
    if (outputVisited.has(current)) continue;
    outputVisited.add(current);
    const output = outputs.get(current);
    if (!output) throw new Error(`headless-output-missing: ${current}`);
    for (const dependency of output.imports) {
      assertServerDependency(current, dependency.path);
      if (dependency.external) external.add(dependency.path);
      else {
        const target = outputs.has(dependency.path) ? dependency.path
          : posix.join(dirname(current), dependency.path);
        outputPending.push(target);
      }
    }
  }
  return {
    schemaVersion: 1,
    entryPoint: entry,
    entry: posix.relative(outputRoot, outputEntry[0]),
    inputCount: visited.size,
    files: [...outputVisited].map((file) => ({ path: posix.relative(outputRoot, file), bytes: outputs.get(file).bytes })).sort((a, b) => a.path.localeCompare(b.path)),
    externals: [...external].sort(),
  };
}
