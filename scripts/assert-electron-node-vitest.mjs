import { basename } from "node:path";
import process from "node:process";

export function assertElectronNodeVitestRuntime({
  env = process.env,
  execPath = process.execPath,
} = {}) {
  const executable = typeof execPath === "string" ? basename(execPath).toLowerCase() : "";
  const isElectronExecutable = executable === "electron" || executable === "electron.exe";
  if (env?.ELECTRON_RUN_AS_NODE === "1" && isElectronExecutable) return;
  throw new Error(
    '[electron-vitest-runner-required] run tests through "bun run test:vitest -- <args>"',
  );
}

assertElectronNodeVitestRuntime();
