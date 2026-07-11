/**
 * `resolveMcpUiBackend` — the ONE serverId→backend resolution the render IPC (and
 * the later oncalltool IPC) share. Proves the loopback-FIRST-then-external order
 * and that the returned backend closes over the serverId.
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
  };
  const mcpManager = {
    readUiResource: vi.fn(async (_id: string, _uri: string) => EXTERNAL_READ),
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
