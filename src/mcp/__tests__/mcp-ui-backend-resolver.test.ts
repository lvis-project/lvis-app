/**
 * `resolveMcpUiBackend` — the ONE serverId→backend resolution the render IPC and the
 * `oncalltool` IPC share. Proves the loopback-FIRST-then-external order for BOTH the
 * `ui://` read and the tool call (one branch, both paths), and that every returned
 * backend member closes over the serverId (an app can never address another server).
 */
import { describe, it, expect, vi } from "vitest";
import { resolveMcpUiBackend } from "../mcp-ui-backend-resolver.js";
import type { McpUiResourceRead } from "../types.js";

const LOOPBACK_READ: McpUiResourceRead = { html: "<p>plugin</p>", csp: { connectDomains: [] } };
const EXTERNAL_READ: McpUiResourceRead = { html: "<p>external</p>" };

function sources(running: string[]) {
  const loopback = {
    has: vi.fn((id: string) => running.includes(id)),
    readUiResource: vi.fn(async (_id: string, _uri: string) => LOOPBACK_READ),
    resolveToolOwner: vi.fn((_id: string, _tool: string) => "acme-cards"),
    callTool: vi.fn(async (_id: string, _tool: string, _args: Record<string, unknown>) => "loopback-result"),
  };
  const mcpManager = {
    readUiResource: vi.fn(async (_id: string, _uri: string) => EXTERNAL_READ),
    resolveToolOwner: vi.fn((_id: string, _tool: string) => "github"),
    callTool: vi.fn(async (_id: string, _tool: string, _args: Record<string, unknown>) => "external-result"),
  };
  return { loopback, mcpManager };
}

describe("resolveMcpUiBackend — loopback-first then external", () => {
  it("routes to the plugin loopback host when one is running for the serverId", async () => {
    const s = sources(["acme-cards"]);
    const backend = resolveMcpUiBackend("acme-cards", s);

    const res = await backend.readUiResource("ui://acme-cards/hello.html");
    expect(res).toBe(LOOPBACK_READ);
    expect(s.loopback.readUiResource).toHaveBeenCalledWith("acme-cards", "ui://acme-cards/hello.html");
    // External registry never consulted when the loopback owns the id.
    expect(s.mcpManager.readUiResource).not.toHaveBeenCalled();
  });

  it("falls back to the external mcpManager registry when no loopback host owns the id", async () => {
    const s = sources([]); // no plugin loopback hosts running
    const backend = resolveMcpUiBackend("github", s);

    const res = await backend.readUiResource("ui://github/pr.html");
    expect(res).toBe(EXTERNAL_READ);
    expect(s.mcpManager.readUiResource).toHaveBeenCalledWith("github", "ui://github/pr.html");
    expect(s.loopback.readUiResource).not.toHaveBeenCalled();
  });

  it("prefers loopback over external even if BOTH could serve the id (loopback wins)", async () => {
    const s = sources(["dual"]);
    await resolveMcpUiBackend("dual", s).readUiResource("ui://dual/x.html");
    expect(s.loopback.readUiResource).toHaveBeenCalledOnce();
    expect(s.mcpManager.readUiResource).not.toHaveBeenCalled();
  });
});

describe("resolveMcpUiBackend — callTool takes the SAME loopback-first resolution", () => {
  it("routes an app's tools/call to the plugin loopback source when one owns the id", async () => {
    const s = sources(["acme-cards"]);
    const backend = resolveMcpUiBackend("acme-cards", s);

    expect(backend.resolveToolOwner("acme_open")).toBe("acme-cards");
    await expect(backend.callTool("acme_open", { id: 1 })).resolves.toBe("loopback-result");

    // Bound to the resolved serverId — the caller never passes one.
    expect(s.loopback.resolveToolOwner).toHaveBeenCalledWith("acme-cards", "acme_open");
    expect(s.loopback.callTool).toHaveBeenCalledWith("acme-cards", "acme_open", { id: 1 });
    expect(s.mcpManager.callTool).not.toHaveBeenCalled();
    expect(s.mcpManager.resolveToolOwner).not.toHaveBeenCalled();
  });

  it("falls back to the external source for a server with no loopback host", async () => {
    const s = sources([]);
    const backend = resolveMcpUiBackend("github", s);

    expect(backend.resolveToolOwner("query")).toBe("github");
    await expect(backend.callTool("query", { q: "x" })).resolves.toBe("external-result");

    expect(s.mcpManager.callTool).toHaveBeenCalledWith("github", "query", { q: "x" });
    expect(s.loopback.callTool).not.toHaveBeenCalled();
  });

  it("resolves the render and the call path to the SAME source (one branch, not two)", async () => {
    const s = sources(["acme-cards"]);
    const backend = resolveMcpUiBackend("acme-cards", s);

    await backend.readUiResource("ui://acme-cards/x.html");
    await backend.callTool("acme_open", {});

    // A duplicated resolution rule would let these two diverge; they cannot here.
    expect(s.loopback.readUiResource).toHaveBeenCalledOnce();
    expect(s.loopback.callTool).toHaveBeenCalledOnce();
    expect(s.mcpManager.readUiResource).not.toHaveBeenCalled();
    expect(s.mcpManager.callTool).not.toHaveBeenCalled();
  });
});
