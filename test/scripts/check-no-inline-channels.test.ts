import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(process.cwd(), "scripts/check-no-inline-channels.mjs");
const nodeCommand = process.env.LVIS_TEST_NODE_EXEC_PATH ?? process.execPath;
const roots: string[] = [];

const BASE_FILES = [
  "src/ipc/domains/example.ts",
  "src/preload.ts",
  "src/preload/internal-surface.ts",
  "src/api/index.ts",
  "src/sdk/index.ts",
  "src/cli/index.ts",
  "src/plugin-preload.ts",
  "src/boot/plugins.ts",
  "src/boot/steps/ipc-bridge.ts",
  "src/boot/steps/post-boot.ts",
] as const;

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lvis-inline-channels-"));
  roots.push(root);
  for (const rel of BASE_FILES) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "export {};\n", "utf-8");
  }
  return root;
}

function run(root: string) {
  return spawnSync(nodeCommand, [SCRIPT, "--root", root], {
    cwd: process.cwd(),
    encoding: "utf-8",
  });
}

function write(root: string, rel: string, source: string): void {
  writeFileSync(join(root, rel), source, "utf-8");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("check-no-inline-channels", () => {
  it("accepts contract constant references", () => {
    const root = createRoot();
    write(root, "src/plugin-preload.ts", "ipcRenderer.invoke(CHANNELS.pluginBridge.callTool);\n");

    const result = run(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[no-inline-channels] OK");
  });

  it.each([
    ["src/plugin-preload.ts", "lvis:plugin:call-tool"],
    ["src/preload/internal-surface.ts", "marketplace:updates-available"],
    ["src/ipc/domains/example.ts", "window:minimize"],
  ])("rejects inline %s wire literals", (rel, channel) => {
    const root = createRoot();
    write(root, rel, `const channel = ${JSON.stringify(channel)};\n`);

    const result = run(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${rel}:1 inline channel literal`);
  });

  it("rejects no-substitution and interpolated template channel literals", () => {
    const root = createRoot();
    write(root, "src/plugin-preload.ts", [
      "const direct = `lvis:plugin:event`;",
      "const dynamic = `lvis:plugin:${kind}`;",
      "",
    ].join("\n"));

    const result = run(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr.match(/src\/plugin-preload\.ts:\d+ inline channel literal/g)).toHaveLength(2);
  });

  it("ignores channel-like text in comments", () => {
    const root = createRoot();
    write(root, "src/plugin-preload.ts", "// `lvis:plugin:event` is documented here.\n");

    expect(run(root).status).toBe(0);
  });

  it("discovers new top-level IPC domain and preload modules", () => {
    const root = createRoot();
    write(root, "src/ipc/domains/new-domain.ts", "const channel = 'window:new-channel';\n");
    write(root, "src/preload/new-surface.ts", "const channel = 'lvis:new-channel';\n");

    const result = run(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("src/ipc/domains/new-domain.ts:1 inline channel literal");
    expect(result.stderr).toContain("src/preload/new-surface.ts:1 inline channel literal");
  });
});
