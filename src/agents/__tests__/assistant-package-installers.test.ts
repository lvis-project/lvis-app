import AdmZip from "adm-zip";
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
  };
}

function makeStore(buffer: Buffer): PluginArtifactStore & {
  extractZip: ReturnType<typeof vi.fn>;
} {
  return {
    downloadVerifiedArtifact: vi.fn(async () => ({
      zipBuffer: buffer,
      artifactSha256: "abc123",
      signerKeyId: "test-key",
    })),
    extractZip: vi.fn(async () => ["plugin.json"]),
    installDirFor: vi.fn(() => "/tmp/lvis-package"),
    writeInstallReceipt: vi.fn(),
    appendHistory: vi.fn(),
  } as unknown as PluginArtifactStore & { extractZip: ReturnType<typeof vi.fn> };
}

describe("assistant package installers", () => {
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
