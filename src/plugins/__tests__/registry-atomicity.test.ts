import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    await rm(root, { recursive: true, force: true });
  });

  it("serializes two actual CLI first writes without creating an empty registry target", async () => {
    for (const id of ["alpha", "beta"]) {
      await mkdir(join(root, id), { recursive: true });
      await writeFile(join(root, id, "plugin.json"), "{}", "utf-8");
    }
    const holder = spawnNode([childFixture, "hold-lock", registryPath], true);
    const holderExitPromise = waitForExit(holder);
    await waitForMessage(holder, "locked");
    expect(existsSync(registryPath)).toBe(false);

    const cli = resolve(repoRoot, "scripts/plugins-cli.ts");
    const first = spawnNode([cli, "--plugins-root", root, "add", "alpha", "alpha/plugin.json"]);
    const second = spawnNode([cli, "--plugins-root", root, "add", "beta", "beta/plugin.json"]);
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
  ])("rejects %s and preserves the original bytes", async (_label, bytes) => {
    await writeFile(registryPath, bytes, "utf-8");
    await expect(updatePluginRegistry(registryPath, (registry) => {
      registry.plugins.push({ id: "new", manifestPath: "new/plugin.json" });
    })).rejects.toThrow();
    expect(await readFile(registryPath, "utf-8")).toBe(bytes);
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
