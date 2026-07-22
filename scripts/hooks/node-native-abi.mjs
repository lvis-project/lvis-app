import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

import { spawnSyncPortable as defaultSpawnSync } from "./spawn-command.mjs";

const PROBE_SCRIPT = [
  'const Database = require("better-sqlite3");',
  'const database = new Database(":memory:");',
  'database.prepare("SELECT 1").get();',
  "database.close();",
].join("");

function resolveElectronFromApp(dir) {
  return createRequire(join(dir, "package.json"))("electron");
}

function failureSummary(result) {
  const output = result.error?.message || result.stderr || result.stdout || "unknown failure";
  return String(output).trim().split(/\r?\n/).find(Boolean) || "unknown failure";
}

export function ensureElectronAbiBetterSqlite3(
  dir,
  {
    electronCommand,
    resolveElectron = resolveElectronFromApp,
    spawnSync = defaultSpawnSync,
    log = console.log,
  } = {}
) {
  const moduleDir = join(dir, "node_modules", "better-sqlite3");
  if (!existsSync(moduleDir)) {
    throw new Error(
      "[electron-native-module-missing] better-sqlite3 is unavailable; run bun install before tests"
    );
  }

  let command = electronCommand;
  if (!command) {
    try {
      command = resolveElectron(dir);
    } catch (error) {
      throw new Error(
        `[electron-runtime-unavailable] could not resolve Electron before tests: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  if (typeof command !== "string" || command.length === 0) {
    throw new Error(
      "[electron-runtime-unavailable] Electron resolved to an invalid executable path"
    );
  }

  const probe = spawnSync(command, ["-e", PROBE_SCRIPT], {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `[electron-native-abi-incompatible] better-sqlite3 Electron ABI probe failed before tests: ${
        failureSummary(probe)
      }`
    );
  }

  log(`[checks] ${basename(dir)} :: better-sqlite3 matches the Electron test ABI`);
  return { state: "compatible" };
}
