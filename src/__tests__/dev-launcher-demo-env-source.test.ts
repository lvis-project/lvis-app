import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");

describe("Electron launchers — demo env parity", () => {
  it("loads repo .env.demo for both start and dev launches before Electron boots", () => {
    const startSource = readFileSync(resolve(repoRoot, "scripts/run-electron.mjs"), "utf8");
    const devSource = readFileSync(resolve(repoRoot, "scripts/run-electron-dev.mjs"), "utf8");
    const loaderSource = readFileSync(resolve(repoRoot, "scripts/lib/demo-env-loader.mjs"), "utf8");
    const codecSource = readFileSync(resolve(repoRoot, "src/main/demo-activation-codec.ts"), "utf8");

    expect(startSource).toContain('import { loadRepoDemoEnv } from "./lib/demo-env-loader.mjs";');
    expect(startSource).toContain('loadRepoDemoEnv(env, new URL("..", import.meta.url).pathname);');
    expect(devSource).toContain('import { loadRepoDemoEnv } from "./lib/demo-env-loader.mjs";');
    expect(devSource).toContain("loadRepoDemoEnv(e, repoRoot);");
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
