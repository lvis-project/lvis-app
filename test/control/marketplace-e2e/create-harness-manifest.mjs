import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const [controlRootArg, controlSha, outputPath] = process.argv.slice(2);
if (!controlRootArg || !/^[0-9a-f]{40}$/.test(controlSha ?? "") || !outputPath) {
  throw new Error("usage: create-harness-manifest.mjs CONTROL_ROOT CONTROL_SHA OUTPUT");
}
const controlRoot = resolve(controlRootArg);
const head = execFileSync("git", ["-C", controlRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (head !== controlSha) throw new Error("trusted control checkout does not match workflow SHA");
const dirty = execFileSync("git", ["-C", controlRoot, "status", "--porcelain=v1"], {
  encoding: "utf8",
}).trim();
if (dirty) throw new Error("trusted control checkout is dirty");

const fixed = [
  "src/shared/llm-vendor-defaults.ts",
  "src/shared/theme-bundles.ts",
  "scripts/run-vitest-under-electron.mjs",
  "scripts/normalize-electron-node-runtime.mjs",
  "test/control/marketplace-e2e/runner-package.json",
  "test/control/marketplace-e2e/runner-bun.lock",
  "test/control/marketplace-e2e/trusted-dependencies.json",
  "test/control/marketplace-e2e/vitest.control.config.ts",
  "test/control/marketplace-e2e/playwright.control.config.ts",
  "test/control/marketplace-e2e/loopback-proxy.mjs",
  "test/control/marketplace-e2e/run-host.mjs",
  "test/control/marketplace-e2e/run-hostile.mjs",
  "test/control/marketplace-e2e/verify-harness.mjs",
  "test/control/marketplace-e2e/verify-trusted-dependencies.mjs",
];
const tree = execFileSync(
  "git",
  ["-C", controlRoot, "ls-tree", "-r", "-z", controlSha, "--", "test/e2e", ...fixed],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const entries = tree.split("\0").filter(Boolean).map((record) => {
  const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(record);
  if (!match) throw new Error(`non-regular trusted harness entry: ${record}`);
  return { gitMode: match[1], source: match[3] };
});
const expectedSources = new Set(entries.map(({ source }) => source));
for (const path of fixed) {
  if (!expectedSources.has(path)) throw new Error(`missing trusted harness file ${path}`);
}
if (!entries.some(({ source }) => source === "test/e2e/ui/ep-attendance-live.spec.ts")) {
  throw new Error("trusted attendance harness is absent from workflow SHA");
}
if (!entries.some(({ source }) => source === "test/e2e/ui/marketplace-live-lifecycle.spec.ts")) {
  throw new Error("trusted Marketplace lifecycle harness is absent from workflow SHA");
}

const files = entries.map(({ source, gitMode }) => {
  const sourcePath = resolve(controlRoot, source);
  const stat = lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`trusted harness source is not a single regular file: ${source}`);
  }
  const bytes = readFileSync(sourcePath);
  let destination;
  if (source.startsWith("test/e2e/")) {
    destination = `/candidate/app/${source}`;
  } else if (source.startsWith("src/shared/")) {
    destination = `/candidate/app/${source}`;
  } else if (source.startsWith("scripts/")) {
    destination = `/trusted/runner/${source}`;
  } else if (source.endsWith("/runner-package.json")) {
    destination = "/trusted/runner/package.json";
  } else if (source.endsWith("/runner-bun.lock")) {
    destination = "/trusted/runner/bun.lock";
  } else if (source.endsWith("/trusted-dependencies.json")) {
    destination = "/trusted/control/trusted-dependencies.json";
  } else if (
    source.endsWith("/vitest.control.config.ts")
    || source.endsWith("/playwright.control.config.ts")
  ) {
    destination = `/trusted/runner/${basename(source)}`;
  } else {
    destination = `/trusted/control/${basename(source)}`;
  }
  return {
    source,
    destination,
    gitMode,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
});

writeFileSync(
  outputPath,
  `${JSON.stringify({ schemaVersion: 1, controlSha, files }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
