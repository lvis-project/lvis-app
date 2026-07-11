/**
 * `oncalltool` handler — the app asked to call a tool on ITS OWN MCP server
 * (`tools/call`). The security-critical one.
 *
 * This module does NOT decide anything. It proxies the request to the host's gated
 * `CHANNELS.mcp.callTool` IPC (via the injected `callTool`, which McpAppView binds
 * to the CARD's `payload.serverId`) and shapes the answer back into the spec's
 * `CallToolResult`. Two consequences worth naming:
 *
 *  - The app NEVER names a server. `tools/call` params carry only `name` +
 *    `arguments`; the server binding is supplied by the trusted renderer and
 *    re-verified in main (tool-owner == serverId). There is no channel here through
 *    which a compromised app could reach another server's tools.
 *  - Denials and failures come back as an MCP-style ERROR RESULT
 *    (`{ isError: true, content: [...] }`), not a thrown/rejected bridge request:
 *    the app sees a normal tool result it can render, and a host denial is not
 *    reported to it as a protocol fault. The host's risk/consent gate (which may
 *    ask the user) runs in main — this handler just awaits its outcome.
 */
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiToolCallOutcome } from "../../../../../mcp/types.js";

/** The `oncalltool` request callback shape, derived from the installed `AppBridge`. */
export type OnCallTool = NonNullable<AppBridge["oncalltool"]>;

/** The `CallToolResult` this handler returns (spec shape, derived off the bridge). */
type CallToolResult = Awaited<ReturnType<OnCallTool>>;

export interface OnCallToolDeps {
  /**
   * Run a tool on the card's OWN server through the host's gated IPC. Already bound
   * to the card's `serverId` by McpAppView — this handler cannot choose a server.
   * Resolves to an outcome; a `{ ok: false }` is a host DENIAL or a tool error.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<McpUiToolCallOutcome>;
}

/** MCP-style error result — what the app gets for any denial or failure. */
function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Render the host tool layer's raw value as a text content block. The host executor's
 * result contract is a rendered string (external MCP tools) or an arbitrary plugin
 * return value (loopback) — it does not carry MCP content blocks, so we do not
 * fabricate typed blocks the host never produced.
 */
function textBlock(result: unknown): { type: "text"; text: string } {
  if (typeof result === "string") return { type: "text", text: result };
  if (result === undefined || result === null) return { type: "text", text: "" };
  try {
    return { type: "text", text: JSON.stringify(result) ?? String(result) };
  } catch {
    return { type: "text", text: String(result) };
  }
}

export function createOnCallTool({ callTool }: OnCallToolDeps): OnCallTool {
  return async ({ name, arguments: args }) => {
    let outcome: McpUiToolCallOutcome;
    try {
      outcome = await callTool(name, args ?? {});
    } catch (err) {
      // The IPC itself failed (transport / unauthorized frame throw). Still an error
      // RESULT, never a rejected bridge request.
      return errorResult(err instanceof Error ? err.message : String(err));
    }
    if (!outcome.ok) return errorResult(outcome.message ?? outcome.error);
    return { content: [textBlock(outcome.result)] };
  };
}
