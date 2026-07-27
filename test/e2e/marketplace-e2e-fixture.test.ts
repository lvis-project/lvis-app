import AdmZip from "adm-zip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approvePendingPlugin,
  buildPluginZip,
  EXACT_LOOPBACK_MARKETPLACE_ORIGIN,
  postMarketplace,
  publishPlugin,
  requireExactLoopbackMarketplaceOrigin,
} from "./marketplace-e2e-fixture.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Marketplace E2E mutation containment", () => {
  it("keeps the hook lifecycle probe ungoverned and dual-visible", () => {
    const slug = "fixture-plugin";
    const zip = new AdmZip(buildPluginZip(slug, "1.0.0", {
      bundledContributions: true,
    }));
    const manifest = JSON.parse(zip.readAsText("plugin.json")) as {
      tools: Array<{ name: string; _meta?: Record<string, unknown> }>;
    };
    const readTool = manifest.tools.find((tool) => tool.name === "fixture_plugin_read");
    const hookProbeTool = manifest.tools.find(
      (tool) => tool.name === "fixture_plugin_read_hook_probe",
    );
    const hookConfig = JSON.parse(zip.readAsText("hooks/audit.json")) as {
      hooks: { PreToolUse: Array<{ matcher: string }> };
    };

    expect(readTool?._meta).toMatchObject({
      "lvisai/operationPolicy": {
        operations: { hook_probe: { kind: "read" } },
      },
    });
    expect(hookProbeTool?._meta).toMatchObject({
      ui: { visibility: ["model", "app"] },
    });
    expect(hookProbeTool?._meta).not.toHaveProperty("lvisai/operationPolicy");
    expect(hookConfig.hooks.PreToolUse).toEqual([
      expect.objectContaining({ matcher: "fixture_plugin_read_hook_probe" }),
    ]);
  });

  it("accepts only the canonical ephemeral Marketplace origin", () => {
    expect(requireExactLoopbackMarketplaceOrigin(EXACT_LOOPBACK_MARKETPLACE_ORIGIN))
      .toBe(EXACT_LOOPBACK_MARKETPLACE_ORIGIN);
    expect(requireExactLoopbackMarketplaceOrigin(`${EXACT_LOOPBACK_MARKETPLACE_ORIGIN}/`))
      .toBe(EXACT_LOOPBACK_MARKETPLACE_ORIGIN);
  });

  it.each([
    "http://127.0.0.1:8766",
    "https://127.0.0.1:8765",
    "http://localhost:8765",
    "http://[::1]:8765",
    "http://marketplace.example:8765",
    "http://127.0.0.1:8765/api/v1",
    "http://127.0.0.1:8765/?target=production",
  ])("rejects non-canonical mutation target %s", (target) => {
    expect(() => requireExactLoopbackMarketplaceOrigin(target))
      .toThrow(/expected exact loopback origin/);
  });

  it("rejects publish and approval before any network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishPlugin(
      "https://marketplace.example",
      "publisher-key",
      "fixture-plugin",
      "1.0.0",
      Buffer.from("fixture"),
    )).rejects.toThrow(/refuses target/);
    await expect(approvePendingPlugin(
      "http://127.0.0.1:8000",
      "admin-key",
      "fixture-plugin",
      "1.0.0",
    )).rejects.toThrow(/refuses target/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects cross-origin and non-root-relative POST paths before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(postMarketplace(
      EXACT_LOOPBACK_MARKETPLACE_ORIGIN,
      "admin-key",
      "//marketplace.example/api/v1/admin/plugins/fixture/yank",
    )).rejects.toThrow(/non-root-relative POST path/);
    await expect(postMarketplace(
      EXACT_LOOPBACK_MARKETPLACE_ORIGIN,
      "admin-key",
      "api/v1/admin/plugins/fixture/yank",
    )).rejects.toThrow(/non-root-relative POST path/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
