import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const KNIP_BINARY = join(ROOT, "node_modules", "knip", "bin", "knip.js");
const GATE_SCRIPT = join(ROOT, "scripts", "check-knip-baseline.mjs");
const KNIP_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  .devDependencies.knip;
const fixtureRoot = mkdtempSync(join(tmpdir(), "lvis-knip-gate-self-test-"));
const fixtureSource = join(fixtureRoot, "src");

let evidence;
try {
  mkdirSync(fixtureSource);
  writeFileSync(join(fixtureRoot, "package.json"), `${JSON.stringify({
    name: "knip-gate-self-test",
    private: true,
    type: "module",
    devDependencies: { knip: KNIP_VERSION },
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(fixtureRoot, "knip-baseline.json"), `${JSON.stringify({
    schemaVersion: 1,
    knipVersion: KNIP_VERSION,
    entries: [],
  }, null, 2)}\n`, "utf8");
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
    [
      GATE_SCRIPT,
      "--root", fixtureRoot,
      "--config", "knip.json",
      "--baseline", "knip-baseline.json",
      "--knip-binary", KNIP_BINARY,
    ],
    { cwd: fixtureRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.signal || result.status !== 1) {
    throw new Error(
      `[knip-self-test] actual gate did not reject fixture (${result.signal ?? result.status}): ${result.stderr}`,
    );
  }
  evidence = result.stderr;
  if (!evidence.includes("[knip-gate] new issues exceed the reviewed baseline")
      || !evidence.includes("files src/unused.ts src/unused.ts")) {
    throw new Error(
      `[knip-self-test] actual gate lacked the expected diagnostic: ${evidence}`,
    );
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

if (existsSync(fixtureRoot)) {
  throw new Error("[knip-self-test] isolated fixture cleanup failed");
}

console.log("[knip-self-test] actual gate exited 1 for isolated unused file and fixture cleaned");
