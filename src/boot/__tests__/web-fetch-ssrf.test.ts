import { describe, expect, it, vi } from "vitest";
import { registerBuiltinTools } from "../tools.js";
import { ToolRegistry } from "../../tools/registry.js";
import { registerStandardCategories } from "../../permissions/category-registry.js";
import { PermissionManager } from "../../permissions/permission-manager.js";

/**
 * web_fetch must route through NetworkGuard.fetchPublicHttpResponse so
 * localhost / private / loopback / metadata endpoints are rejected before a
 * real network request is made. This test relies on NetworkGuard's
 * ensurePublicHttpUrl pre-check which rejects based on DNS resolution of
 * reserved ranges — no live network required.
 */
describe("web_fetch SSRF guard", () => {
  function makeWebFetchTool(workflowDeps?: Parameters<typeof registerBuiltinTools>[2]) {
    const registry = new ToolRegistry();
    const settingsStub = {
      get: () => ({ provider: "duckduckgo" }),
      getSecret: () => null,
    } as unknown as Parameters<typeof registerBuiltinTools>[1];
    registerBuiltinTools(registry, settingsStub, workflowDeps);
    const tool = registry
      .getVisibleTools()
      .find((t) => t.name === "web_fetch");
    if (!tool) throw new Error("web_fetch not registered");
    return tool;
  }

  it("rejects http://localhost with isError=true and no network hit", async () => {
    const tool = makeWebFetchTool();
    const result = await tool.execute({ url: "http://localhost/secret" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/non-public address|did not resolve|http and https/i);
  });

  it("rejects http://127.0.0.1", async () => {
    const tool = makeWebFetchTool();
    const result = await tool.execute({ url: "http://127.0.0.1/" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/non-public address/i);
  });

  it("rejects AWS metadata endpoint 169.254.169.254", async () => {
    const tool = makeWebFetchTool();
    const result = await tool.execute(
      { url: "http://169.254.169.254/latest/meta-data/" },
      {} as never,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/non-public address/i);
  });

  it("rejects file:// scheme", async () => {
    const tool = makeWebFetchTool();
    const result = await tool.execute({ url: "file:///etc/passwd" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/http and https/i);
  });

  it("scopes private network access behind a separate approval key", () => {
    const tool = makeWebFetchTool();

    expect(tool.category).toBe("read");
    expect(tool.categoryForInput?.({
      url: "http://10.185.177.209:8080/status",
      allowPrivateNetwork: true,
    })).toBe("network");
    expect(tool.approvalCacheKey?.({
      url: "http://10.185.177.209:8080/status",
      allowPrivateNetwork: true,
    })).toBe("private-network:http://10.185.177.209:8080");
    expect(tool.approvalCacheKey?.({
      url: "http://10.185.177.209:8080/status",
    })).toBeUndefined();
  });

  it("does not reuse the bare web_fetch allow rule for private network access", () => {
    registerStandardCategories();
    const pm = new PermissionManager();
    pm.setRules([{ pattern: "web_fetch", action: "allow" }]);

    const publicDecision = pm.checkDetailed("web_fetch", "builtin", "network", null, {});
    expect(publicDecision.decision).toBe("allow");

    const privateDecision = pm.checkDetailed(
      "web_fetch",
      "builtin",
      "network",
      null,
      { approvalCacheKey: "web_fetch:private-network:http://10.185.177.209:8080" },
    );
    expect(privateDecision.decision).toBe("ask");
  });

  it("still rejects loopback when private network access is requested", async () => {
    const tool = makeWebFetchTool();
    const result = await tool.execute(
      { url: "http://127.0.0.1/", allowPrivateNetwork: true },
      {} as never,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/non-public address/i);
  });

  it("uses the injected network fetch so host resolver rules apply to tool calls", async () => {
    const networkFetch = vi.fn(async () =>
      new Response("<html><body>resolved through electron</body></html>", { status: 200 }),
    );
    const tool = makeWebFetchTool({ networkFetch: networkFetch as typeof fetch });

    const result = await tool.execute(
      { url: "http://10.185.177.209/page", allowPrivateNetwork: true },
      {} as never,
    );

    expect(result.isError).toBe(false);
    expect(networkFetch).toHaveBeenCalledOnce();
    expect(result.output).toContain("resolved through electron");
  });

  it("treats demo host-resolver mapped hosts as private-network approvals", async () => {
    const tool = makeWebFetchTool({
      demoActiveVendor: "azure-foundry",
      demoHostMap: "example.test.openai.azure.com=10.182.192.10",
    });
    const input = { url: "https://example.test.openai.azure.com/openai/v1/" };

    expect(tool.categoryForInput?.(input)).toBe("network");
    expect(tool.approvalCacheKey?.(input)).toBe(
      "private-network:https://example.test.openai.azure.com",
    );
  });

  it("allows mapped private addresses only through the private-network path", async () => {
    const networkFetch = vi.fn(async () =>
      new Response("<html><body>mapped private address</body></html>", { status: 200 }),
    );
    const tool = makeWebFetchTool({
      networkFetch: networkFetch as typeof fetch,
      demoActiveVendor: "azure-foundry",
      demoHostMap: "10.185.177.209=10.182.192.10",
    });

    const result = await tool.execute(
      { url: "http://10.185.177.209/page" },
      {} as never,
    );

    expect(result.isError).toBe(false);
    expect(networkFetch).toHaveBeenCalledOnce();
    expect(result.output).toContain("mapped private address");
  });
});
