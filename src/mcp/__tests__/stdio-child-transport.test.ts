/**
 * Out-of-process plugin path end-to-end (untrusted-stdio-isolation §3.1):
 * PluginMcpHost drives a REAL spawned `node` subprocess over StdioChildTransport
 * — proving the SAME host/projection works over a different (process-isolating)
 * transport, plus crash containment.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { StdioChildTransport } from "../experimental/stdio-child-transport.js";
import { PluginMcpHost } from "../plugin-mcp-host.js";
import { ToolRegistry } from "../../tools/registry.js";

const FIXTURE = resolve(__dirname, "..", "..", "..", "test", "fixtures", "mcp", "echo-stdio-server.mjs");

function makeHost(registry: ToolRegistry): PluginMcpHost {
  const transport = new StdioChildTransport(process.execPath, [FIXTURE]);
  // The host registers tools under the plugin id namespace; "echo" stands in for
  // the spawned plugin's id.
  return new PluginMcpHost("echo", transport, registry);
}

describe("StdioChildTransport — out-of-process plugin over a real subprocess", () => {
  it("discovers + registers the subprocess plugin's tools and round-trips a call", async () => {
    const registry = new ToolRegistry();
    const host = makeHost(registry);

    const registered = await host.start();
    expect(registered).toEqual(["echo_say"]);

    const tool = registry.findByName("echo_say");
    expect(tool?.source).toBe("plugin");
    // Completing #885 per-tool category removal (out-of-process/stdio residual):
    // the host IGNORES a plugin's wire-declared `_meta["xyz.lvis/category"]` — the
    // fixture still SENDS "read" (see echo-stdio-server.mjs), but the reverse
    // projection registers the default-strict "write" baseline just like the
    // in-process loopback path. Under `hostClassifiesRisk` (default ON, all
    // platforms) `inspectHostRisk` is the authoritative per-invocation classifier;
    // the declared/wire category is SHADOW-ONLY, never an enforcement input, so
    // this is fail-safe (read→write only tightens; enforcement is unaffected). A
    // plugin grading its own danger is not a control (MCP spec: a server can lie).
    expect(tool?.category).toBe("write");

    const out = await tool!.execute({ msg: "hi" }, {} as never);
    expect(out).toEqual({ output: "echo: hi", isError: false });

    await host.stop();
  }, 15_000);

  it("contains a plugin crash — a mid-call subprocess exit surfaces as an error, not a hang", async () => {
    const registry = new ToolRegistry();
    const host = makeHost(registry);
    await host.start();

    // The fixture process.exit(7)s on { crash: true }; the pending request must
    // reject (transport onClose) rather than hang forever.
    const result = await registry.findByName("echo_say")!.execute({ crash: true }, {} as never);
    expect(result.isError).toBe(true);

    await host.stop();
  }, 15_000);
});
