/**
 * Regression lock: declared `toolSchemas[name].category` propagation through the
 * LIVE first-party plugin registration path (the loopback-MCP pipeline that
 * `boot/steps/plugin-runtime.ts` wires via `PluginLoopbackManager.syncAll`).
 *
 * Why this test exists — production incident (2026-06-26 permission audit):
 * every first-party plugin tool was recorded with `category:"write"` and denied
 * by the Layer-5 reviewer ("reviewer high: write path not declared" / "no
 * isolation"), EVEN tools the source manifest declares `category:"read"`
 * (`msgraph_calendar_today`, `msgraph_email_list`, `lge_meeting_availability`,
 * `lge_profile_info`, `work_assistant_list_detectors`). Builtins (`web_search`,
 * `web_fetch`) were unaffected (declared `read` → allow).
 *
 * Root cause was NOT this pipeline: the forward projection
 * (`manifestToolsToMcpTools` → `_meta["xyz.lvis/category"]`) and the reverse
 * projection (`mcpToolToPluginTool` → `readCategory`) faithfully round-trip a
 * DECLARED category. The denial came from the INSTALLED/published plugin
 * manifests having shed the per-tool `category` field entirely (it became
 * optional under host-classifies-risk). With the field ABSENT the forward
 * projection applies `DEFAULT_STRICT_CATEGORY = "write"`, and with
 * `hostClassifiesRisk` OFF (default) `ToolExecutor.resolveEnforcedCategory`
 * returns that declared `write` unchanged → reviewer denies.
 *
 * This test pins all three legs of the contract through the REAL production
 * path (`PluginMcpHost.loopback().start()` → `ToolRegistry`) so the pipeline can
 * never silently:
 *   - lose a declared `read` (the bug the incident was first mis-attributed to),
 *   - lose a declared `write`, or
 *   - classify an UNDECLARED tool anywhere other than the safe default-strict
 *     `write` baseline (a silent downgrade to `read` would be a security defect;
 *     a throw would regress the host-classifies-risk "category is optional" load
 *     contract).
 */
import { describe, it, expect, vi } from "vitest";
import { PluginMcpHost } from "../plugin-mcp-host.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { PluginToolDelegate } from "../plugin-mcp-server.js";
import type { PluginManifest } from "../../plugins/types.js";

/**
 * A manifest that mirrors the production shape: one tool that DECLARES
 * `category:"read"`, one that declares `category:"write"`, and one that OMITS
 * the category (the published-manifest state that triggered the incident).
 */
const MANIFEST = {
  id: "com.example.mixed",
  name: "Mixed",
  version: "3.1.0",
  entry: "dist/index.js",
  description: "mixed-category ops",
  tools: ["mixed_read", "mixed_write", "mixed_undeclared"],
  toolSchemas: {
    mixed_read: {
      description: "Declared read",
      category: "read",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
    mixed_write: {
      description: "Declared write",
      category: "write",
      inputSchema: { type: "object", properties: { body: { type: "string" } } },
    },
    // No `category` — exactly the installed/published-manifest state behind the
    // 2026-06-26 incident.
    mixed_undeclared: {
      description: "No declared category",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  },
} as unknown as PluginManifest;

const okDelegate: PluginToolDelegate = vi.fn(async (name) => ({
  content: [{ type: "text", text: `ran ${name}` }],
}));

describe("declared category propagation — loopback-MCP plugin tools (production path)", () => {
  it("a manifest-declared read tool registers with Tool.category === 'read'", async () => {
    const registry = new ToolRegistry();
    await PluginMcpHost.loopback(MANIFEST, okDelegate, registry).start();

    const read = registry.findByName("mixed_read");
    expect(read?.source).toBe("plugin");
    expect(read?.category).toBe("read");
    expect(read?.isReadOnly({})).toBe(true);
  });

  it("a manifest-declared write tool registers with Tool.category === 'write'", async () => {
    const registry = new ToolRegistry();
    await PluginMcpHost.loopback(MANIFEST, okDelegate, registry).start();

    const write = registry.findByName("mixed_write");
    expect(write?.category).toBe("write");
    expect(write?.isReadOnly({})).toBe(false);
  });

  it("an undeclared-category tool falls to the default-strict 'write' baseline (NOT read, no throw)", async () => {
    const registry = new ToolRegistry();
    // The whole plugin must still register (host-classifies-risk: category is
    // optional) — a missing declaration must not abort the load.
    const registered = await PluginMcpHost.loopback(MANIFEST, okDelegate, registry).start();
    expect(registered).toEqual(["mixed_read", "mixed_write", "mixed_undeclared"]);

    const undeclared = registry.findByName("mixed_undeclared");
    expect(undeclared?.category).toBe("write");
    // Critical security invariant: undeclared MUST NOT be classified as read.
    expect(undeclared?.category).not.toBe("read");
    expect(undeclared?.isReadOnly({})).toBe(false);
  });
});
