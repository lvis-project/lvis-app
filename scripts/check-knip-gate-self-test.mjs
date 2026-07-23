import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareKnipBaseline,
  formatKnipIssue,
  normalizeKnipIssues,
} from "./lib/knip-baseline.mjs";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const KNIP_BINARY = join(ROOT, "node_modules", "knip", "bin", "knip.js");
const fixtureRoot = mkdtempSync(join(tmpdir(), "lvis-knip-gate-self-test-"));
const fixtureSource = join(fixtureRoot, "src");

let evidence;
try {
  mkdirSync(fixtureSource);
  writeFileSync(
    join(fixtureRoot, "package.json"),
    `${JSON.stringify({ name: "knip-gate-self-test", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(fixtureRoot, "knip.json"),
    `${JSON.stringify({
      entry: ["src/main.ts"],
      project: ["src/**/*.ts"],
      rules: { files: "warn" },
    }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(fixtureSource, "main.ts"), "export const liveEntry = true;\n", "utf8");
  writeFileSync(
    join(fixtureSource, "unused.ts"),
    "export const intentionallyUnusedKnipFixture = true;\n",
    "utf8",
  );

  const result = spawnSync(
    process.execPath,
    [KNIP_BINARY, "--config", "knip.json", "--reporter", "json"],
    { cwd: fixtureRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) {
    throw new Error(
      `[knip-self-test] engine failed (${result.signal ?? result.status}): ${result.stderr}`,
    );
  }

  const issues = normalizeKnipIssues(JSON.parse(result.stdout));
  const { added } = compareKnipBaseline(issues, []);
  evidence = added.map(formatKnipIssue);
  if (!evidence.includes("files src/unused.ts src/unused.ts")) {
    throw new Error(
      `[knip-self-test] unused fixture did not exceed the empty baseline: ${evidence.join("; ")}`,
    );
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

if (existsSync(fixtureRoot)) {
  throw new Error("[knip-self-test] isolated fixture cleanup failed");
}

console.log("[knip-self-test] isolated unused file rejected and fixture cleaned");
