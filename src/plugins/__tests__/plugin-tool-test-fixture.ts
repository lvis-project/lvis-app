/**
 * Test-only helper: build the canonical {@link Tool}s for a plugin manifest the
 * way the PRODUCTION loopback path does (manifest → `manifestToolsToMcpTools` →
 * `mcpToolToPluginTool` over a `pluginRuntimeToolDelegate`), but synchronously —
 * no transport round-trip. Replaces the deleted legacy `pluginToolsForRegistration`
 * for tests that need plugin-tool fixtures; it reuses the SAME projection +
 * authority + #1182 lint as `PluginMcpHost.start`, so fixtures match reality
 * (incl. the fail-closed throw on a missing `_meta` category).
 *
 * NOT a `*.test.ts` file → vitest does not execute it as a suite.
 */
import { manifestToolsToMcpTools } from "../../mcp/plugin-server-projection.js";
import { mcpToolToPluginTool } from "../../mcp/plugin-tool-from-mcp.js";
import { pluginRuntimeToolDelegate } from "../../mcp/plugin-runtime-delegate.js";
import { lintToolInputSchema } from "../tool-schema-lint.js";
import type { Tool } from "../../tools/base.js";
import type { PluginRuntime } from "../runtime.js";
import type { PluginManifest } from "../types.js";

const RAW_RESULT_META = "lvisai/rawResult";

export function buildPluginToolsForTest(
  pluginRuntime: PluginRuntime,
  pluginId: string,
  manifest: PluginManifest,
): Tool[] {
  const delegate = pluginRuntimeToolDelegate(pluginRuntime, pluginId);
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const outcome = await delegate(name, args);
    const text = outcome.content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
    if (outcome.isError) throw new Error(text);
    const meta = outcome._meta;
    const rawResult =
      meta && Object.prototype.hasOwnProperty.call(meta, RAW_RESULT_META)
        ? { value: meta[RAW_RESULT_META] }
        : undefined;
    return { text, rawResult };
  };

  const tools: Tool[] = [];
  for (const mcpTool of manifestToolsToMcpTools(manifest)) {
    // Build FIRST, THEN the #1182 provider-strict lint drop — same order as
    // PluginMcpHost.start. A missing/invalid category no longer hard-throws
    // (host-classifies-risk: default-strict write-equivalent).
    const built = mcpToolToPluginTool(pluginId, mcpTool, invoke);
    if (lintToolInputSchema(mcpTool.inputSchema).length > 0) continue;
    tools.push(built);
  }
  return tools;
}
