import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PluginUninstallCleanupJournal,
} from "../plugin-uninstall-cleanup-journal.js";

const roots: string[] = [];

function fixture(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "lvis-uninstall-journal-"));
  roots.push(root);
  return {
    root,
    path: join(root, "plugin-uninstall-cleanup.json"),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })),
  );
});

describe("PluginUninstallCleanupJournal", () => {
  it("persists phase and per-partition progress across process restart", () => {
    const { path } = fixture();
    const journal = new PluginUninstallCleanupJournal(path);
    journal.prepare({
      pluginId: "ep-api",
      installPluginId: "ep-api",
      secretKeys: ["apiKey"],
      authPartitions: [
        "persist:plugin-auth:ep-api",
        "persist:plugin-auth:ep-api:tenant",
      ],
      cleanupCache: true,
    });
    journal.beginAttempt("ep-api");
    journal.completePhase("ep-api", "config");
    journal.completeAuthPartition(
      "ep-api",
      "persist:plugin-auth:ep-api:tenant",
    );

    const reloaded = new PluginUninstallCleanupJournal(path);
    expect(reloaded.find("ep-api")).toMatchObject({
      pluginId: "ep-api",
      attempts: 1,
      completedPhases: ["config"],
      completedAuthPartitions: [
        "persist:plugin-auth:ep-api:tenant",
      ],
    });
  });

  it("rejects auth partitions outside the plugin-owned namespace", () => {
    const { path } = fixture();
    const journal = new PluginUninstallCleanupJournal(path);

    expect(() =>
      journal.prepare({
        pluginId: "ep-api",
        installPluginId: "ep-api",
        secretKeys: [],
        authPartitions: ["persist:plugin-auth:other-plugin"],
        cleanupCache: false,
      })).toThrow(/invalid plugin uninstall cleanup plan/);
    expect(journal.list()).toEqual([]);
  });

  it("fails loudly on malformed durable records", async () => {
    const { path } = fixture();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        cleanups: [{
          pluginId: "ep-api",
          installPluginId: "ep-api",
          secretKeys: [],
          authPartitions: ["persist:default"],
          cleanupCache: true,
          recordedAt: new Date(0).toISOString(),
          attempts: 0,
          completedPhases: [],
          completedAuthPartitions: [],
        }],
      }),
    );

    expect(() => new PluginUninstallCleanupJournal(path)).toThrow(
      /invalid plugin uninstall cleanup journal record/,
    );
  });

  it("stores cleanup keys and phases without secret values or raw failures", async () => {
    const { path } = fixture();
    const journal = new PluginUninstallCleanupJournal(path);
    journal.prepare({
      pluginId: "ep-api",
      installPluginId: "ep-api",
      secretKeys: ["attendanceToken"],
      authPartitions: ["persist:plugin-auth:ep-api"],
      cleanupCache: false,
    });
    journal.beginAttempt("ep-api");

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("attendanceToken");
    expect(raw).not.toContain("super-secret-value");
    expect(raw).not.toContain("EPERM: operator home path");
  });

  it("retains independent cleanup ownership for multiple plugins", () => {
    const { path } = fixture();
    const journal = new PluginUninstallCleanupJournal(path);
    for (const pluginId of ["ep-api", "agent-hub"]) {
      journal.prepare({
        pluginId,
        installPluginId: pluginId,
        secretKeys: [],
        authPartitions: [
          `persist:plugin-auth:${encodeURIComponent(pluginId)}`,
        ],
        cleanupCache: true,
      });
    }

    expect(
      new PluginUninstallCleanupJournal(path)
        .list()
        .map((record) => record.pluginId)
        .sort(),
    ).toEqual(["agent-hub", "ep-api"]);
  });

  it("durably merges late auth partitions and reopens tracker cleanup", () => {
    const { path } = fixture();
    const journal = new PluginUninstallCleanupJournal(path);
    journal.prepare({
      pluginId: "ep-api",
      installPluginId: "ep-api",
      secretKeys: [],
      authPartitions: ["persist:plugin-auth:ep-api"],
      cleanupCache: false,
    });
    journal.completeAuthPartition("ep-api", "persist:plugin-auth:ep-api");
    journal.completePhase("ep-api", "auth-tracker");

    journal.mergeAuthPartitions("ep-api", [
      "persist:plugin-auth:ep-api:late",
    ]);
    expect(new PluginUninstallCleanupJournal(path).find("ep-api")).toMatchObject({
      authPartitions: [
        "persist:plugin-auth:ep-api",
        "persist:plugin-auth:ep-api:late",
      ],
      completedAuthPartitions: ["persist:plugin-auth:ep-api"],
      completedPhases: [],
    });
    expect(() =>
      journal.mergeAuthPartitions("ep-api", [
        "persist:plugin-auth:other-plugin",
      ])).toThrow(/invalid plugin uninstall auth partition plan/);
  });

  it("checkpoints registry removal and cache ownership in the durable record", () => {
    const { path } = fixture();
    const journal = new PluginUninstallCleanupJournal(path);
    journal.prepare({
      pluginId: "ep-api",
      installPluginId: "ep-api",
      secretKeys: [],
      authPartitions: [],
      cleanupCache: false,
    });

    journal.markRegistryRemovalCommitted("ep-api", { cleanupCache: true });
    expect(new PluginUninstallCleanupJournal(path).find("ep-api")).toMatchObject({
      registryRemovalCommitted: true,
      cleanupCache: true,
    });
  });
});
