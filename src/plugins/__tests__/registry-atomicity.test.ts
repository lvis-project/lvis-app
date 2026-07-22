import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import lockfile from "proper-lockfile";
import { readPluginRegistry, updatePluginRegistry } from "../registry.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const childFixture = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/registry-process-child.ts");
const nodeCommand = process.env.LVIS_TEST_NODE_EXEC_PATH ?? process.execPath;

function spawnNode(args: string[], ipc = false): ChildProcess {
  return spawn(nodeCommand, ["--import=tsx", ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: ipc ? ["ignore", "inherit", "inherit", "ipc"] : ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
}

function waitForMessage(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolveMessage, reject) => {
    child.once("error", reject);
    child.on("message", (message) => {
      if (message === expected) resolveMessage();
    });
  });
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit({ code, stderr }));
  });
}

describe("plugin registry transaction atomicity", () => {
  let root: string;
  let registryPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lvis-registry-atomicity-"));
    registryPath = join(root, "registry.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("serializes two child-process first writes without creating an empty registry target", async () => {
    const holder = spawnNode([childFixture, "hold-lock", registryPath], true);
    const holderExitPromise = waitForExit(holder);
    await waitForMessage(holder, "locked");
    expect(existsSync(registryPath)).toBe(false);

    const first = spawnNode([childFixture, "update", registryPath, "alpha"]);
    const second = spawnNode([childFixture, "update", registryPath, "beta"]);
    const firstExitPromise = waitForExit(first);
    const secondExitPromise = waitForExit(second);
    holder.send?.("release");
    const [firstExit, secondExit] = await Promise.all([firstExitPromise, secondExitPromise]);
    holder.kill();
    await holderExitPromise;
    expect(firstExit, firstExit.stderr).toMatchObject({ code: 0 });
    expect(secondExit, secondExit.stderr).toMatchObject({ code: 0 });
    expect((await readPluginRegistry(registryPath)).plugins.map((entry) => entry.id)).toEqual(["alpha", "beta"]);
  }, 20_000);

  it("keeps CLI list available without mutating the registry", async () => {
    const original = `${JSON.stringify({ version: 1, plugins: [] }, null, 2)}\n`;
    await writeFile(registryPath, original, "utf-8");
    const cli = resolve(repoRoot, "scripts/plugins-cli.ts");
    const listResult = await waitForExit(spawnNode([cli, "--plugins-root", root, "list"]));
    expect(listResult.code).toBe(0);
    expect(await readFile(registryPath, "utf-8")).toBe(original);
  });

  it.each(["add", "remove", "enable", "disable"])(
    "rejects CLI %s so a running host cannot silently diverge",
    async (command) => {
      const original = `${JSON.stringify({ version: 1, plugins: [] }, null, 2)}\n`;
      await writeFile(registryPath, original, "utf-8");
      const cli = resolve(repoRoot, "scripts/plugins-cli.ts");
      const child = spawnNode([cli, "--plugins-root", root, command, "alpha", "alpha/plugin.json"]);
      const result = await waitForExit(child);
      expect(result.code).not.toBe(0);
      expect(await readFile(registryPath, "utf-8")).toBe(original);
    },
  );

  it("keeps local-install guidance on the host-owned Settings flow", async () => {
    const activeReferences = [
      "README.md",
      "docs/ko/app-readme.md",
      "docs/ko/guides/local-plugin-development.md",
      "docs/ko/guides/windows-setup.md",
      "scripts/plugins-cli.ts",
      "scripts/run-electron-dev.mjs",
      "src/plugins/registry.ts",
    ];
    for (const relativePath of activeReferences) {
      const content = await readFile(resolve(repoRoot, relativePath), "utf-8");
      expect(content, relativePath).not.toMatch(/lvis-cli install|bun run cli(?: --)? install|install file:\/\//i);
    }

    const usage = await waitForExit(spawnNode([
      resolve(repoRoot, "scripts/plugins-cli.ts"),
      "--plugins-root",
      root,
      "install",
    ]));
    expect(usage.code).not.toBe(0);
    const cliSource = await readFile(resolve(repoRoot, "scripts/plugins-cli.ts"), "utf-8");
    expect(cliSource).toContain("Settings > Plugin Config > Developer tools");
    expect(cliSource).toContain("build folder containing plugin.json");
  });

  it.each(["remove", "enable", "disable", "install"])(
    "serializes child-process %s contention and preserves unrelated entries",
    async (operation) => {
      await writeFile(registryPath, `${JSON.stringify({
        version: 1,
        plugins: [
          { id: "base", manifestPath: "base/plugin.json", enabled: operation !== "enable" },
          ...(operation === "install" ? [] : [{ id: "target", manifestPath: "target/plugin.json", enabled: operation === "enable" ? false : true }]),
        ],
      }, null, 2)}\n`, "utf-8");
      const holder = spawnNode([childFixture, "hold-lock", registryPath], true);
      const holderExitPromise = waitForExit(holder);
      await waitForMessage(holder, "locked");
      const targetId = operation === "install" ? "installed" : "target";
      const operationChild = spawnNode([childFixture, operation, registryPath, targetId]);
      const unrelatedChild = spawnNode([childFixture, "install", registryPath, `unrelated-${operation}`]);
      const operationExit = waitForExit(operationChild);
      const unrelatedExit = waitForExit(unrelatedChild);
      holder.send?.("release");
      const results = await Promise.all([operationExit, unrelatedExit]);
      holder.kill();
      await holderExitPromise;
      expect(results.every((result) => result.code === 0)).toBe(true);
      const registry = await readPluginRegistry(registryPath);
      expect(registry.plugins.some((entry) => entry.id === "base")).toBe(true);
      expect(registry.plugins.some((entry) => entry.id === `unrelated-${operation}`)).toBe(true);
      const target = registry.plugins.find((entry) => entry.id === targetId);
      if (operation === "remove") expect(target).toBeUndefined();
      if (operation === "enable") expect(target?.enabled).toBe(true);
      if (operation === "disable") expect(target?.enabled).toBe(false);
      if (operation === "install") expect(target?.installSource).toBe("user");
    },
    20_000,
  );

  it("serializes explicit migration against a concurrent mutation", async () => {
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [{ id: "legacy", manifestPath: "legacy/plugin.json", installedBy: "user" }],
    }), "utf-8");
    const holder = spawnNode([childFixture, "hold-lock", registryPath], true);
    const holderExitPromise = waitForExit(holder);
    await waitForMessage(holder, "locked");
    const migration = spawnNode([childFixture, "migrate", registryPath]);
    const mutation = spawnNode([childFixture, "update", registryPath, "concurrent"]);
    const migrationExitPromise = waitForExit(migration);
    const mutationExitPromise = waitForExit(mutation);
    holder.send?.("release");
    const results = await Promise.all([migrationExitPromise, mutationExitPromise]);
    holder.kill();
    await holderExitPromise;
    expect(results.every((result) => result.code === 0), results.map((result) => result.stderr).join("\n")).toBe(true);
    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins.map((entry) => entry.id)).toEqual(["concurrent", "legacy"]);
    expect(registry.plugins.find((entry) => entry.id === "legacy")?.installSource).toBe("user");
  }, 20_000);

  it.each([
    ["empty bytes", ""],
    ["invalid JSON", "{ nope"],
    ["invalid structure", JSON.stringify({ version: 1, plugins: [{ id: "bad", manifestPath: "bad/plugin.json", enabled: "yes" }] })],
    ["malformed legacy fields", JSON.stringify({ version: 1, plugins: [{ id: "bad", manifestPath: "bad/plugin.json", installedBy: "root", _devLinked: "yes" }] })],
    ["malformed nested access", JSON.stringify({ version: 1, plugins: [{ id: "bad", manifestPath: "bad/plugin.json", approvedPluginAccess: { plugins: [{ pluginId: "peer", events: ["ok", 7] }] } }] })],
  ])("rejects %s and preserves the original bytes", async (_label, bytes) => {
    await writeFile(registryPath, bytes, "utf-8");
    await expect(updatePluginRegistry(registryPath, (registry) => {
      registry.plugins.push({ id: "new", manifestPath: "new/plugin.json" });
    })).rejects.toThrow();
    expect(await readFile(registryPath, "utf-8")).toBe(bytes);
  });

  it("rejects a nested mutation before it can enqueue a delayed write", async () => {
    await expect(updatePluginRegistry(registryPath, () => (
      updatePluginRegistry(registryPath, (registry) => {
        registry.plugins.push({ id: "late", manifestPath: "late/plugin.json" });
      })
    ))).rejects.toThrow("Nested plugin registry mutation is not allowed");

    // A later transaction drains everything that could have been queued. If
    // the nested call escaped, its `late` entry would be visible here.
    await updatePluginRegistry(registryPath, (registry) => {
      registry.plugins.push({ id: "after", manifestPath: "after/plugin.json" });
    });
    expect((await readPluginRegistry(registryPath)).plugins.map((entry) => entry.id)).toEqual(["after"]);
  });

  it("rejects an async mutator without persisting its eventual changes", async () => {
    await expect(updatePluginRegistry(registryPath, async () => {
      await Promise.resolve();
      await updatePluginRegistry(registryPath, (registry) => {
        registry.plugins.push({ id: "late", manifestPath: "late/plugin.json" });
      });
    })).rejects.toThrow("Plugin registry mutator must be synchronous");

    await updatePluginRegistry(registryPath, (registry) => {
      registry.plugins.push({ id: "after", manifestPath: "after/plugin.json" });
    });
    expect((await readPluginRegistry(registryPath)).plugins.map((entry) => entry.id)).toEqual(["after"]);
  });

  it("preserves the old target and cleans staging after an injected pre-rename failure", async () => {
    const original = `${JSON.stringify({ version: 1, plugins: [{ id: "old", manifestPath: "old/plugin.json" }] }, null, 2)}\n`;
    await writeFile(registryPath, original, "utf-8");
    const child = spawnNode([childFixture, "fail-rename", registryPath, "new"]);
    const result = await waitForExit(child);
    expect(result.code).not.toBe(0);
    expect(await readFile(registryPath, "utf-8")).toBe(original);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("converges after a committed registry rename with failed directory sync", async () => {
    await writeFile(registryPath, `${JSON.stringify({ version: 1, plugins: [] }, null, 2)}\n`, "utf-8");
    const child = spawnNode([childFixture, "committed-sync-error", registryPath, "committed"]);
    const result = await waitForExit(child);
    expect(result.code).toBe(0);
    expect((await readPluginRegistry(registryPath)).plugins.map((entry) => entry.id)).toEqual(["committed"]);
  });

  it("converges a committed registry mutation when lock release fails", async () => {
    const realLock = lockfile.lock.bind(lockfile);
    let releaseFailureInjected = false;
    vi.spyOn(lockfile, "lock").mockImplementationOnce(async (...args) => {
      const release = await realLock(...args);
      return async () => {
        await release();
        releaseFailureInjected = true;
        throw new Error("injected lock release failure");
      };
    });
    const result = await updatePluginRegistry(registryPath, (registry) => {
      registry.plugins.push({ id: "committed", manifestPath: "committed/plugin.json" });
      return "committed-result";
    });

    expect(releaseFailureInjected).toBe(true);
    expect(result).toBe("committed-result");
    expect((await readPluginRegistry(registryPath)).plugins.map((entry) => entry.id)).toEqual(["committed"]);
  });

  it("converges an existing receipt replacement after failed directory sync", async () => {
    const receiptPath = join(root, "receipt-plugin", "install-receipt.json");
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify({ schemaVersion: 1, pluginId: "receipt-plugin" })}\n`, "utf-8");
    const child = spawnNode([childFixture, "receipt-committed-sync-error", root, "receipt-plugin"]);
    const result = await waitForExit(child);
    expect(result.code).toBe(0);
    const receipt = JSON.parse(await readFile(receiptPath, "utf-8")) as { schemaVersion: number; version: string };
    expect(receipt).toMatchObject({ schemaVersion: 2, version: "2.0.0" });
  });

  it("converges an exact raw receipt restore after failed directory sync", async () => {
    const receiptPath = join(root, "receipt-plugin", "install-receipt.json");
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, "new receipt bytes\n", "utf-8");
    const child = spawnNode([childFixture, "raw-receipt-committed-sync-error", root, "receipt-plugin"]);
    const result = await waitForExit(child);
    expect(result.code).toBe(0);
    expect(await readFile(receiptPath, "utf-8")).toBe("restored receipt bytes\n");
  });

  it("preserves an existing receipt when replacement fails before rename", async () => {
    const receiptPath = join(root, "receipt-plugin", "install-receipt.json");
    await mkdir(dirname(receiptPath), { recursive: true });
    const original = `${JSON.stringify({ schemaVersion: 1, pluginId: "receipt-plugin" })}\n`;
    await writeFile(receiptPath, original, "utf-8");
    const child = spawnNode([childFixture, "receipt-fail-rename", root, "receipt-plugin"]);
    const result = await waitForExit(child);
    expect(result.code).not.toBe(0);
    expect(await readFile(receiptPath, "utf-8")).toBe(original);
    expect((await readdir(dirname(receiptPath))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("ignores a killed writer's staged file and recovers on the next transaction", async () => {
    const original = `${JSON.stringify({ version: 1, plugins: [{ id: "old", manifestPath: "old/plugin.json" }] }, null, 2)}\n`;
    await writeFile(registryPath, original, "utf-8");
    const child = spawnNode([childFixture, "pause-before-rename", registryPath, "killed"], true);
    const childExitPromise = waitForExit(child);
    await waitForMessage(child, "staged");
    child.kill("SIGKILL");
    await childExitPromise;
    expect(await readFile(registryPath, "utf-8")).toBe(original);
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(true);
    const staleTime = new Date(Date.now() - 20_000);
    await utimes(`${registryPath}.lock-anchor.lock`, staleTime, staleTime);

    await updatePluginRegistry(registryPath, (registry) => {
      registry.plugins.push({ id: "recovered", manifestPath: "recovered/plugin.json" });
    });
    expect((await readPluginRegistry(registryPath)).plugins.map((entry) => entry.id)).toEqual(["old", "recovered"]);
  }, 20_000);
});
