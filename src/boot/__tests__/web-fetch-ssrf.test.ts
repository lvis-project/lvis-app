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
      demoHostMapApplied: true,
      demoHostMap: "example.test.openai.azure.com=10.182.192.10",
    });
    const input = { url: "https://example.test.openai.azure.com/openai/v1/" };

    expect(tool.categoryForInput?.(input)).toBe("network");
    expect(tool.approvalCacheKey?.(input)).toBe(
      "private-network:https://example.test.openai.azure.com",
    );
  });

  it("allows mapped private addresses only through the direct private-network fetch path", async () => {
    const networkFetch = vi.fn(async () =>
      new Response("<html><body>system proxy path</body></html>", { status: 200 }),
    );
    const privateNetworkFetch = vi.fn(async () =>
      new Response("<html><body>mapped private address</body></html>", { status: 200 }),
    );
    const tool = makeWebFetchTool({
      networkFetch: networkFetch as typeof fetch,
      privateNetworkFetch: privateNetworkFetch as typeof fetch,
      demoActiveVendor: "azure-foundry",
      demoHostMapApplied: true,
      demoHostMap: "10.185.177.209=10.182.192.10",
    });

    const result = await tool.execute(
      { url: "http://10.185.177.209/page" },
      {} as never,
    );

    expect(result.isError).toBe(false);
    expect(privateNetworkFetch).toHaveBeenCalledOnce();
    expect(networkFetch).not.toHaveBeenCalled();
    expect(result.output).toContain("mapped private address");
  });

  it("re-evaluates demo host mapping on every redirect hop before using direct fetch", async () => {
    const networkFetch = vi.fn(async () =>
      new Response("<html><body>public redirect target</body></html>", { status: 200 }),
    );
    const privateNetworkFetch = vi.fn(async () =>
      new Response("", {
        status: 302,
        headers: { location: "http://93.184.216.34/final" },
      }),
    );
    const tool = makeWebFetchTool({
      networkFetch: networkFetch as typeof fetch,
      privateNetworkFetch: privateNetworkFetch as typeof fetch,
      demoActiveVendor: "azure-foundry",
      demoHostMapApplied: true,
      demoHostMap: "10.185.177.209=10.182.192.10",
    });

    const result = await tool.execute(
      { url: "http://10.185.177.209/page" },
      {} as never,
    );

    expect(result.isError).toBe(false);
    expect(privateNetworkFetch).toHaveBeenCalledOnce();
    expect(networkFetch).toHaveBeenCalledOnce();
    expect(networkFetch).toHaveBeenCalledWith(
      "http://93.184.216.34/final",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(result.output).toContain("public redirect target");
  });

  it("blocks mapped demo redirects to unmapped private hosts without broadening approval", async () => {
    const networkFetch = vi.fn(async () =>
      new Response("<html><body>unmapped private target</body></html>", { status: 200 }),
    );
    const privateNetworkFetch = vi.fn(async () =>
      new Response("", {
        status: 302,
        headers: { location: "http://10.0.0.2/final" },
      }),
    );
    const tool = makeWebFetchTool({
      networkFetch: networkFetch as typeof fetch,
      privateNetworkFetch: privateNetworkFetch as typeof fetch,
      demoActiveVendor: "azure-foundry",
      demoHostMapApplied: true,
      demoHostMap: "10.185.177.209=10.182.192.10",
    });

    const result = await tool.execute(
      { url: "http://10.185.177.209/page" },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(privateNetworkFetch).toHaveBeenCalledOnce();
    expect(networkFetch).not.toHaveBeenCalled();
    expect(result.output).toContain("non-public address");
  });

  it("fails mapped demo fetches when the direct private-network fetch is not wired", async () => {
    const networkFetch = vi.fn(async () =>
      new Response("<html><body>system proxy path</body></html>", { status: 200 }),
    );
    const tool = makeWebFetchTool({
      networkFetch: networkFetch as typeof fetch,
      demoActiveVendor: "azure-foundry",
      demoHostMapApplied: true,
      demoHostMap: "10.185.177.209=10.182.192.10",
    });

    const result = await tool.execute(
      { url: "http://10.185.177.209/page" },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(networkFetch).not.toHaveBeenCalled();
    expect(result.output).toContain("private endpoint fetch is not configured");
  });

  it("does not treat raw demo host-map entries as private when resolver rules were not applied", async () => {
    const networkFetch = vi.fn(async () =>
      new Response("<html><body>normal network path</body></html>", { status: 200 }),
    );
    const privateNetworkFetch = vi.fn(async () =>
      new Response("<html><body>direct private path</body></html>", { status: 200 }),
    );
    const tool = makeWebFetchTool({
      networkFetch: networkFetch as typeof fetch,
      privateNetworkFetch: privateNetworkFetch as typeof fetch,
      demoActiveVendor: "azure-foundry",
      demoHostMapApplied: false,
      demoHostMap: "93.184.216.34=10.182.192.10",
    });
    const input = { url: "http://93.184.216.34/page" };

    expect(tool.categoryForInput?.(input)).toBe("read");
    expect(tool.approvalCacheKey?.(input)).toBeUndefined();
    const result = await tool.execute(input, {} as never);

    expect(result.isError).toBe(false);
    expect(networkFetch).toHaveBeenCalledOnce();
    expect(privateNetworkFetch).not.toHaveBeenCalled();
    expect(result.output).toContain("normal network path");
  });
});
