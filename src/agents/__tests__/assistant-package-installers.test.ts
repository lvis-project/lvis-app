import AdmZip from "adm-zip";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { installAgentPackageFromMarketplace } from "../agent-installer.js";
import { installSkillPackageFromMarketplace } from "../../skills/skill-installer.js";
import type { MarketplaceFetcher } from "../../plugins/marketplace-fetcher.js";
import type { PluginArtifactStore } from "../../plugins/plugin-artifact-store.js";
import type { PluginMarketplaceItem } from "../../plugins/types.js";

function zipBuffer(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [filename, contents] of Object.entries(files)) {
    zip.addFile(filename, Buffer.from(contents, "utf-8"));
  }
  return zip.toBuffer();
}

function marketplaceItem(pluginType: "agent" | "skill"): PluginMarketplaceItem {
  return {
    id: pluginType === "agent" ? "reviewer" : "audit",
    name: pluginType === "agent" ? "Reviewer" : "Audit",
    description: "",
    packageSpec: "",
    packageName: "",
    tools: [],
    version: "1.0.0",
    pluginType,
  };
}

function makeFetcher(pluginType: "agent" | "skill"): MarketplaceFetcher {
  return {
    listPlugins: vi.fn(async () => [marketplaceItem(pluginType)]),
    getPluginDetail: vi.fn(async () => marketplaceItem(pluginType)),
    downloadVersion: vi.fn(),
    listAnnouncements: vi.fn(async () => []),
  };
}

function makeStore(buffer: Buffer): PluginArtifactStore & {
  extractZip: ReturnType<typeof vi.fn>;
} {
  const installRoot = resolve("/tmp/lvis-package");
  return {
    downloadVerifiedArtifact: vi.fn(async () => ({
      zipBuffer: buffer,
      artifactSha256: "abc123",
      signerKeyId: "test-key",
    })),
    extractZip: vi.fn(async () => ["plugin.json"]),
    installDirFor: vi.fn(() => installRoot),
    writeInstallReceipt: vi.fn(),
    appendHistory: vi.fn(),
  } as unknown as PluginArtifactStore & { extractZip: ReturnType<typeof vi.fn> };
}

describe("assistant package installers", () => {
  it("end-to-end: installs an agent package and records the marketplace registry entry", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lvis-agent-package-"));
    try {
      const store = makeStore(zipBuffer({
        "plugin.json": JSON.stringify({ id: "reviewer", version: "1.0.0" }),
        "AGENTS.md": "---\nname: reviewer\n---\nDo reviewer work.\n",
      }));
      const registryPath = join(tmp, "agents.json");

      const result = await installAgentPackageFromMarketplace("reviewer", {
        fetcher: makeFetcher("agent"),
        store,
        registryPath,
      });

      expect(result).toEqual({
        agentId: "reviewer",
        slug: "reviewer",
        version: "1.0.0",
        installed: true,
      });
      expect(store.extractZip).toHaveBeenCalledWith("reviewer", expect.any(Buffer));
      expect(store.writeInstallReceipt).toHaveBeenCalledWith(
        "reviewer",
        expect.objectContaining({
          version: "1.0.0",
          installSource: "marketplace",
          artifactSha256: "abc123",
          signerKeyId: "test-key",
        }),
      );
      const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
        agents: Array<{ id: string; source: string; enabled: boolean; profilePath: string; manifestPath: string }>;
      };
      expect(registry.agents).toHaveLength(1);
      expect(registry.agents[0]).toMatchObject({
        id: "reviewer",
        source: "marketplace",
        enabled: true,
        profilePath: join(resolve("/tmp/lvis-package"), "AGENTS.md"),
        manifestPath: join(resolve("/tmp/lvis-package"), "plugin.json"),
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("end-to-end: installs a skill package and records the marketplace registry entry", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "lvis-skill-package-"));
    try {
      const store = makeStore(zipBuffer({
        "plugin.json": JSON.stringify({ id: "audit", version: "1.0.0" }),
        "SKILL.md": "---\nname: audit\n---\nUse audit checks.\n",
      }));
      const registryPath = join(tmp, "skills.json");

      const result = await installSkillPackageFromMarketplace("audit", {
        fetcher: makeFetcher("skill"),
        store,
        registryPath,
      });

      expect(result).toEqual({
        skillId: "audit",
        slug: "audit",
        version: "1.0.0",
        installed: true,
      });
      expect(store.extractZip).toHaveBeenCalledWith("audit", expect.any(Buffer));
      expect(store.writeInstallReceipt).toHaveBeenCalledWith(
        "audit",
        expect.objectContaining({
          version: "1.0.0",
          installSource: "marketplace",
          artifactSha256: "abc123",
          signerKeyId: "test-key",
        }),
      );
      const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
        skills: Array<{ id: string; source: string; enabled: boolean; skillPath: string; manifestPath: string }>;
      };
      expect(registry.skills).toHaveLength(1);
      expect(registry.skills[0]).toMatchObject({
        id: "audit",
        source: "marketplace",
        enabled: true,
        skillPath: join(resolve("/tmp/lvis-package"), "SKILL.md"),
        manifestPath: join(resolve("/tmp/lvis-package"), "plugin.json"),
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an empty agent profile before extracting the package", async () => {
    const store = makeStore(zipBuffer({
      "plugin.json": "{}",
      "AGENTS.md": "---\nname: reviewer\n---\n\n",
    }));

    await expect(
      installAgentPackageFromMarketplace("reviewer", {
        fetcher: makeFetcher("agent"),
        store,
        registryPath: "/tmp/lvis-agent-registry.json",
      }),
    ).rejects.toThrow(/empty AGENTS\.md body/);

    expect(store.extractZip).not.toHaveBeenCalled();
  });

  it("rejects an empty skill body before extracting the package", async () => {
    const store = makeStore(zipBuffer({
      "plugin.json": "{}",
      "SKILL.md": "---\nname: audit\n---\n\n",
    }));

    await expect(
      installSkillPackageFromMarketplace("audit", {
        fetcher: makeFetcher("skill"),
        store,
        registryPath: "/tmp/lvis-skill-registry.json",
      }),
    ).rejects.toThrow(/empty SKILL\.md body/);

    expect(store.extractZip).not.toHaveBeenCalled();
  });

  it("rejects a package that declares a different agent name", async () => {
    const store = makeStore(zipBuffer({
      "plugin.json": "{}",
      "AGENTS.md": "---\nname: imagegen\n---\nDo reviewer work.\n",
    }));

    await expect(
      installAgentPackageFromMarketplace("reviewer", {
        fetcher: makeFetcher("agent"),
        store,
        registryPath: "/tmp/lvis-agent-registry.json",
      }),
    ).rejects.toThrow(/must match the package slug/);

    expect(store.extractZip).not.toHaveBeenCalled();
  });

  it("rejects a package that declares a different skill name", async () => {
    const store = makeStore(zipBuffer({
      "plugin.json": "{}",
      "SKILL.md": "---\nname: imagegen\n---\nUse audit checks.\n",
    }));

    await expect(
      installSkillPackageFromMarketplace("audit", {
        fetcher: makeFetcher("skill"),
        store,
        registryPath: "/tmp/lvis-skill-registry.json",
      }),
    ).rejects.toThrow(/must match the package slug/);

    expect(store.extractZip).not.toHaveBeenCalled();
  });
});
