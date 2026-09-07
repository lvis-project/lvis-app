import { describe, expect, it, vi } from "vitest";
import { registerBuiltinTools } from "../tools.js";
import { ToolRegistry } from "../../tools/registry.js";
import { registerStandardCategories } from "../../permissions/category-registry.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";

/**
 * web_fetch must route through NetworkGuard.fetchPublicHttpResponse so
 * localhost / private / loopback / metadata endpoints are rejected before a
 * real network request is made. This test relies on NetworkGuard's
 * ensurePublicHttpUrl pre-check which rejects based on DNS resolution of
 * reserved ranges — no live network required.
 */
describe("web_fetch SSRF guard", () => {
  function makeWebFetchTool(
    workflowDeps: Parameters<typeof registerBuiltinTools>[2] = {
      networkFetch: unusedNetworkFetch,
    },
  ) {
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

  it("keeps the network category for every destination", () => {
    const tool = makeWebFetchTool();

    // `network` for BOTH public and private destinations: the URL is
    // model-chosen, so a public fetch is an egress channel just as much as a
    // private one, and every exclusion resting on this category keeps applying
    // to both. Which public fetches actually prompt is decided by the request
    // screen in the risk classifier, not here.
    expect(tool.category).toBe("network");
    expect(tool.categoryForInput?.({
      url: "https://example.com/page",
    })).toBe("network");
    expect(tool.categoryForInput?.({
      url: "http://10.185.177.209:8080/status",
      allowPrivateNetwork: true,
    })).toBe("network");
  });

  it("remembers an approval per destination host, not per URL", () => {
    const tool = makeWebFetchTool();

    // The host is the unit a person can decide about, and the unit that bounds
    // where data can go. A key per URL would make "always allow" mean "this
    // exact page"; the tool name alone would make it mean "anywhere".
    expect(tool.approvalCacheKey?.({
      url: "https://docs.example.org/guide/install",
    })).toBe("web_fetch:host:docs.example.org");
    expect(tool.approvalCacheKey?.({
      url: "https://DOCS.example.ORG/other/page?q=1",
    })).toBe("web_fetch:host:docs.example.org");
    expect(tool.approvalCacheKey?.({
      url: "https://other.example.org/guide",
    })).not.toBe("web_fetch:host:docs.example.org");
    expect(tool.approvalCacheKey?.({ url: "not a url" })).toBeUndefined();
  });

  it("keeps a private-network grant distinct from the public one for the same host", () => {
    const tool = makeWebFetchTool();

    const privateKey = tool.approvalCacheKey?.({
      url: "http://10.185.177.209:8080/status",
      allowPrivateNetwork: true,
    });
    const publicKey = tool.approvalCacheKey?.({
      url: "http://10.185.177.209:8080/status",
    });
    expect(privateKey).toBe("web_fetch:host:private-network:10.185.177.209");
    expect(publicKey).toBe("web_fetch:host:10.185.177.209");
    expect(privateKey).not.toBe(publicKey);
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
      { approvalCacheKey: "web_fetch:host:private-network:10.185.177.209" },
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

  it("uses the injected Electron network fetch for tool calls", async () => {
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

});
