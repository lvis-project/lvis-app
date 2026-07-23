/**
 * Phase 1.5 Option C — PluginRuntime.listPluginCards() tests.
 *
 * Verifies catalog shape used by SystemPromptBuilder + request_plugin:
 *   - id / name / description / sampleTools (max 3)
 *   - toolSchemas descriptions are stitched when present
 *   - Falls back to `Plugin: {name}` when toolSchemas absent
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileLegacyToolSurface,
  TestPluginRuntime as PluginRuntime,
} from "./test-helpers.js";

function writePlugin(root: string, id: string, opts: {
  name: string;
  tools: string[];
  icon?: string;
  iconText?: string;
  networkAccess?: {
    allowedDomains: string[];
    reasoning?: string;
    allowPrivateNetworks?: boolean;
  };
  ui?: Array<{
    id: string;
    slot: "sidebar";
    kind: "embedded-module" | "embedded-page" | "info-card" | "action";
    title: string;
    displayName?: string;
    entry?: string;
    exportName?: string;
  }>;
  toolSchemas?: Record<string, {
    description: string;
    category: "read" | "write" | "shell" | "network";
    inputSchema: { type: "object"; properties: Record<string, unknown> };
  }>;
}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    name: opts.name,
    version: "1.0.0",
    description: "Test fixture.",
    publisher: "Test fixture",
    entry: "index.mjs",
    icon: opts.icon,
    iconText: opts.iconText,
    networkAccess: opts.networkAccess,
    // Pure v6: per-tool descriptions carried by the Tool object (compiled from the
    // legacy toolSchemas map); no separate toolSchemas map in the written manifest.
    tools: compileLegacyToolSurface({ tools: opts.tools, toolSchemas: opts.toolSchemas }),
    ui: opts.ui,
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  const handlers = opts.tools
    .map((t) => `  ${t}: async () => ({ ok: true })`)
    .join(",\n");
  writeFileSync(
    join(dir, "index.mjs"),
    `export default () => ({ handlers: {\n${handlers}\n} });`,
  );
  return join(dir, "plugin.json");
}

function writeRegistry(root: string, entries: Array<{ id: string; manifestPath: string; enabled?: boolean }>) {
  const registryDir = join(root, "plugins");
  mkdirSync(registryDir, { recursive: true });
  const registryPath = join(registryDir, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ version: 1, plugins: entries }));
  return registryPath;
}

describe("PluginRuntime.listPluginCards — Phase 1.5 Option C catalog", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lvis-cards-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns id, name, description, sampleTools (max 3)", async () => {
    const manifestA = writePlugin(tmp, "example-meeting", {
      name: "Meeting",
      tools: ["meeting_start", "meeting_push_chunk", "meeting_stop", "meeting_extra"],
      toolSchemas: {
        meeting_start: { description: "회의 시작 명령 — 녹음 개시", category: "write", inputSchema: { type: "object", properties: {} } },
        meeting_push_chunk: { description: "오디오 청크 전송 (스트리밍)", category: "write", inputSchema: { type: "object", properties: {} } },
        meeting_stop: { description: "회의 종료 명령 — 녹음 중단", category: "write", inputSchema: { type: "object", properties: {} } },
      },
    });

    const runtime = new PluginRuntime({ hostRoot: tmp, manifestPaths: [manifestA] });
    await runtime.load();

    const cards = runtime.listPluginCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("example-meeting");
    expect(cards[0].name).toBe("Meeting");
    expect(cards[0].sampleTools).toEqual(["meeting_start", "meeting_push_chunk", "meeting_stop"]);
    // Schema v3 requires manifest.description; it takes priority over toolSchemas derivation.
    expect(cards[0].description).toBe("Test fixture.");
    // Per-tool descriptions from toolSchemas are still accessible via toolDescriptions.
    expect(cards[0].toolDescriptions?.["meeting_start"]).toContain("회의 시작");
    expect(cards[0].toolDescriptions?.["meeting_push_chunk"]).toContain("오디오 청크 전송");
  });

  it("surfaces manifest sidebar UI metadata on plugin cards", async () => {
    const manifestA = writePlugin(tmp, "example-indexer", {
      name: "Local Indexer",
      tools: ["index_scan"],
      icon: "Plug",
      iconText: "LI",
      ui: [
        {
          id: "local-indexer-control",
          slot: "sidebar",
          kind: "embedded-module",
          title: "Local Indexer",
          entry: "dist/ui/indexer-control.js",
          exportName: "PluginUi",
        },
      ],
    });

    const runtime = new PluginRuntime({ hostRoot: tmp, manifestPaths: [manifestA] });
    await runtime.load();

    const card = runtime.listPluginCards()[0];
    expect(card.icon).toBe("Plug");
    expect(card.iconText).toBe("LI");
    expect(card.uiExtensions).toEqual([
      expect.objectContaining({
        id: "local-indexer-control",
        slot: "sidebar",
        kind: "embedded-module",
        title: "Local Indexer",
        entry: "dist/ui/indexer-control.js",
        exportName: "PluginUi",
      }),
    ]);
  });

  it("surfaces manifest networkAccess disclosure on plugin cards", async () => {
    const manifestA = writePlugin(tmp, "example-network", {
      name: "Network",
      tools: ["network_read"],
      networkAccess: {
        allowedDomains: ["api.example.com"],
        reasoning: "Required for remote API calls.",
      },
    });

    const runtime = new PluginRuntime({ hostRoot: tmp, manifestPaths: [manifestA] });
    await runtime.load();

    expect(runtime.listPluginCards()[0].networkAccess).toEqual({
      allowedDomains: ["api.example.com"],
      reasoning: "Required for remote API calls.",
    });
  });

  it("adds a runtime revision cache key to loaded plugin UI entry URLs", async () => {
    const manifestA = writePlugin(tmp, "example-indexer", {
      name: "Local Indexer",
      tools: ["index_scan"],
      ui: [
        {
          id: "local-indexer-control",
          slot: "sidebar",
          kind: "embedded-module",
          title: "Local Indexer",
          entry: "dist/ui/indexer-control.js",
          exportName: "PluginUi",
        },
      ],
    });
    mkdirSync(join(tmp, "example-indexer", "dist", "ui"), { recursive: true });
    writeFileSync(join(tmp, "example-indexer", "dist", "ui", "indexer-control.js"), "export default function mount() {}\n");

    const runtime = new PluginRuntime({ hostRoot: tmp, manifestPaths: [manifestA] });
    await runtime.load();

    const first = runtime.listUiExtensions()[0];
    expect(first.runtimeRevision).toBeGreaterThan(0);
    expect(first.entryUrl).toBeTruthy();
    const firstUrl = new URL(first.entryUrl!);
    expect(firstUrl.searchParams.get("lvisPluginVersion")).toBe("1.0.0");
    expect(firstUrl.searchParams.get("lvisRuntimeRevision")).toBe(String(first.runtimeRevision));

    await runtime.reloadPlugin("example-indexer");

    const second = runtime.listUiExtensions()[0];
    expect(second.runtimeRevision).toBeGreaterThan(first.runtimeRevision!);
    expect(second.entryUrl).not.toBe(first.entryUrl);
    expect(new URL(second.entryUrl!).searchParams.get("lvisRuntimeRevision")).toBe(String(second.runtimeRevision));
  });

  it("uses manifest description when toolSchemas absent", async () => {
    const manifestA = writePlugin(tmp, "example-plain", {
      name: "Plain",
      tools: ["plain_do"],
    });

    const runtime = new PluginRuntime({ hostRoot: tmp, manifestPaths: [manifestA] });
    await runtime.load();

    const cards = runtime.listPluginCards();
    expect(cards[0].description).toBe("Test fixture.");
    expect(cards[0].sampleTools).toEqual(["plain_do"]);
  });

  it("MEDIUM-1: sampleTools excludes deny-rule-blocked tools when toolRegistry provided", async () => {
    const manifestA = writePlugin(tmp, "example-filtered", {
      name: "Filtered",
      tools: ["filtered_a", "filtered_b", "filtered_c"],
    });

    const runtime = new PluginRuntime({ hostRoot: tmp, manifestPaths: [manifestA] });
    await runtime.load();

    // Fake toolRegistry that only exposes filtered_a and filtered_c (filtered_b is denied).
    // listPluginCards feeds the MODEL-visible set (getModelVisibleTools) to the card UI —
    // see the runtime's comment at that call site.
    const fakeRegistry = {
      getModelVisibleTools: () => [{ name: "filtered_a" }, { name: "filtered_c" }],
    };

    const cards = runtime.listPluginCards(fakeRegistry);
    expect(cards[0].sampleTools).toEqual(["filtered_a", "filtered_c"]);
    expect(cards[0].sampleTools).not.toContain("filtered_b");
  });

  it("surfaces disabled and failed plugin loadStatus values from registry-backed runtime", async () => {
    const disabledManifest = writePlugin(tmp, "example-disabled", {
      name: "Disabled",
      tools: ["disabled_read"],
    });
    const failedDir = join(tmp, "example-failed");
    mkdirSync(failedDir, { recursive: true });
    writeFileSync(join(failedDir, "plugin.json"), JSON.stringify({
      id: "example-failed",
      name: "Failed",
      version: "1.0.0",
      description: "Test fixture.",
      publisher: "Test fixture",
      entry: "index.mjs",
      tools: ["failed_read"],
    }));
    writeFileSync(
      join(failedDir, "index.mjs"),
      `throw new Error("boom"); export default () => ({ handlers: { failed_read: async () => ({ ok: true }) } });`,
    );
    const registryPath = writeRegistry(tmp, [
      { id: "example-disabled", manifestPath: disabledManifest, enabled: false },
      { id: "example-failed", manifestPath: join(failedDir, "plugin.json"), enabled: true },
    ]);

    const runtime = new PluginRuntime({ hostRoot: tmp, registryPath, pluginsRoot: tmp });
    await runtime.load();

    const cards = runtime.listPluginCards().sort((a, b) => a.id.localeCompare(b.id));
    expect(cards).toEqual([
      expect.objectContaining({ id: "example-disabled", loadStatus: "disabled" }),
      expect.objectContaining({ id: "example-failed", loadStatus: "failed" }),
    ]);
  });

  it("surfaces registry ids as install aliases when the manifest id differs", async () => {
    const manifestPath = writePlugin(tmp, "manifest-owned-id", {
      name: "Alias Fixture",
      tools: ["alias_ping"],
    });
    const registryPath = writeRegistry(tmp, [
      { id: "marketplace-package-slug", manifestPath, enabled: true },
    ]);

    const runtime = new PluginRuntime({ hostRoot: tmp, registryPath, pluginsRoot: tmp });
    await runtime.load();

    expect(runtime.listPluginCards()).toEqual([
      expect.objectContaining({
        id: "manifest-owned-id",
        installAliases: ["marketplace-package-slug"],
      }),
    ]);
  });
});
