import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createRegistryEntryCache } from "../registry-cache.js";

describe("plugin runtime registry-entry cache", () => {
  it("fails closed for pending replacements while retaining normal host-owned metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-entry-cache-"));
    try {
      const registryPath = join(dir, "registry.json");
      await writeFile(registryPath, JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "pending",
            manifestPath: "pending/plugin.json",
            installSource: "admin",
            manifestSha256: "a".repeat(64),
            pendingUpdate: {
              kind: "marketplace",
              previousManifestFileSha256: "b".repeat(64),
              previousReceiptRaw: null,
            },
          },
          {
            id: "ready",
            manifestPath: "ready/plugin.json",
            installSource: "admin",
            manifestSha256: "c".repeat(64),
          },
        ],
      }));
      const cache = createRegistryEntryCache({ registryPath, log: { warn: vi.fn() } });

      await cache.refreshRegistryEntryCache();

      expect(cache.getRegistryEntry("pending")).toBeUndefined();
      expect(cache.getRegistryEntry("ready")).toEqual({
        installSource: "admin",
        manifestSha256: "c".repeat(64),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
