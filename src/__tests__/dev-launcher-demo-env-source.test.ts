import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");

describe("Electron launchers — demo env parity", () => {
  it("loads repo .env.demo for both start and dev launches before Electron boots", () => {
    const startSource = readFileSync(resolve(repoRoot, "scripts/run-electron.mjs"), "utf8");
    const devSource = readFileSync(resolve(repoRoot, "scripts/run-electron-dev.mjs"), "utf8");

    expect(startSource).toContain('import { loadRepoDemoEnv } from "./lib/demo-env-loader.mjs";');
    expect(startSource).toContain('loadRepoDemoEnv(env, new URL("..", import.meta.url).pathname);');
    expect(devSource).toContain('import { loadRepoDemoEnv } from "./lib/demo-env-loader.mjs";');
    expect(devSource).toContain("loadRepoDemoEnv(e, repoRoot);");
  });
});
