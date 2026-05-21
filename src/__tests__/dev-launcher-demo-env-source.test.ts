import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");

describe("Electron launchers — demo env parity", () => {
  it("shares Electron launch policy helpers across start/dev launchers", () => {
    const startSource = readFileSync(resolve(repoRoot, "scripts/run-electron.mjs"), "utf8");
    const devSource = readFileSync(resolve(repoRoot, "scripts/run-electron-dev.mjs"), "utf8");
    const nsisSmokeSource = readFileSync(
      resolve(repoRoot, "scripts/smoke-windows-nsis-installer.mjs"),
      "utf8",
    );

    for (const source of [startSource, devSource]) {
      expect(source).toContain('from "./lib/electron-launch-options.mjs";');
      expect(source).toContain("prepareElectronLaunchEnv");
      expect(source).toContain("prepareElectronLaunchArgs");
      expect(source).not.toContain('from "./electron-flags.mjs";');
    }
    expect(startSource).toContain("prepareElectronLaunchEnv(env, {");
    expect(devSource).toContain("return prepareElectronLaunchEnv(e, { demoEnvRoot: repoRoot });");
    expect(devSource).not.toContain('LVIS_WIN_NO_SANDBOX: process.env.LVIS_WIN_NO_SANDBOX ?? "1"');
    expect(nsisSmokeSource).toContain("prepareElectronLaunchEnv");
    expect(nsisSmokeSource).toContain("prepareElectronLaunchArgs");
    expect(nsisSmokeSource).not.toContain("const WINDOWS_SAFE_GPU_FLAGS = [");
  });

  it("loads repo .env.demo for both start and dev launches before Electron boots", () => {
    const startSource = readFileSync(resolve(repoRoot, "scripts/run-electron.mjs"), "utf8");
    const devSource = readFileSync(resolve(repoRoot, "scripts/run-electron-dev.mjs"), "utf8");
    const loaderSource = readFileSync(resolve(repoRoot, "scripts/lib/demo-env-loader.mjs"), "utf8");
    const codecSource = readFileSync(resolve(repoRoot, "src/main/demo-activation-codec.ts"), "utf8");

    expect(startSource).toContain('import { fileURLToPath } from "node:url";');
    expect(startSource).toContain('const repoRoot = fileURLToPath(new URL("..", import.meta.url));');
    expect(startSource).toContain("demoEnvRoot: repoRoot");
    expect(devSource).toContain("demoEnvRoot: repoRoot");
    expect(loaderSource).toContain('import { parseEnvDemoText } from "./env-demo-parser.mjs";');
    expect(codecSource).toContain('export { parseEnvDemoText } from "../../scripts/lib/env-demo-parser.mjs";');
  });

  it("shares the dev activation relaunch exit code between IPC and the dev watcher", () => {
    const demoIpcSource = readFileSync(resolve(repoRoot, "src/ipc/domains/demo.ts"), "utf8");
    const devExitSource = readFileSync(resolve(repoRoot, "scripts/lib/dev-electron-exit.mjs"), "utf8");

    expect(demoIpcSource).toContain(
      'import { DEMO_ACTIVATION_DEV_RELAUNCH_EXIT_CODE } from "../../../scripts/lib/dev-electron-exit.mjs";',
    );
    expect(devExitSource).toContain("export const DEMO_ACTIVATION_DEV_RELAUNCH_EXIT_CODE = 42;");
    expect(demoIpcSource).not.toContain("const DEMO_ACTIVATION_DEV_RELAUNCH_EXIT_CODE = 42;");
  });
});
