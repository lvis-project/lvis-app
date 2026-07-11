/**
 * The two `tools/call` SOURCE implementations behind the ONE
 * {@link resolveMcpUiBackend} seam — the backends an MCP App's `oncalltool`
 * reaches when it calls a tool on its OWN server.
 *
 * Both funnel into the SAME host gate the model's tool calls take (ToolExecutor →
 * `inspectHostRisk` → reviewer/approval → audit). Neither one invokes a tool
 * directly: `mcpManager.callTool` (raw `tools/call` on the wire) and a raw plugin
 * handler call both BYPASS the gate and are never used here.
 *
 * ── `userAction: false`, always ────────────────────────────────────────────────
 * An MCP App runs in an UNTRUSTED sandboxed iframe. A "the user clicked" claim
 * originating inside it is not verifiable by the host (the renderer's real
 * `navigator.userActivation` belongs to the host frame, not the guest, and the
 * guest can synthesize a call at any time). So an app-initiated call is NEVER
 * marked user-initiated: it must earn its consent from the approval gate like any
 * other non-user-initiated tool call. A consequence, and a good one: the
 * app-only-visibility plugin dispatch path (`callDeclaredAppOnlyTool`, which skips
 * the reviewer) requires a genuine user activation, so an MCP App can never reach
 * that ungoverned bypass — it fails closed with an activation error.
 */
import type { Tool } from "../tools/base.js";
import type { PluginToolInvocationDelegate } from "../plugins/runtime/index.js";

/** The `PluginRuntime` subset the loopback (first-party plugin) source needs. */
export interface PluginToolCallRuntime {
  /** `method → owning pluginId` (a loopback server's id IS its pluginId). */
  resolveToolOwner(method: string): string | undefined;
  /**
   * The gated renderer→plugin invocation path. Enforces `assertUiActionInvokable`
   * (the tool's `_meta.ui.visibility` MUST include `"app"` — the SPEC MUST for this
   * backend, enforced there and nowhere else) and delegates to the ToolExecutor.
   */
  callFromUi(
    method: string,
    payload?: unknown,
    options?: { userAction?: boolean },
  ): Promise<unknown>;
}

/** What the external (foreign MCP server) source needs from the host. */
export interface ExternalToolCallDeps {
  /** `serverId + server-local name → §6.4 registry name` (governance SoT). */
  namespacedToolName(serverId: string, toolName: string): string;
  /** §6.4 ToolRegistry lookup — the gated `Tool` built by `mcp-tool-adapter`. */
  findTool(name: string): Tool | undefined;
  /** The gated tool-invocation delegate (ToolExecutor). Null before boot wires it. */
  getInvoker(): PluginToolInvocationDelegate | null;
}

/**
 * Loopback source — the card's server is a first-party plugin's in-process MCP
 * host, so its tools are plugin methods. Ownership comes from the runtime's method
 * map; the visibility MUST + the gate both live inside `callFromUi`.
 */
export function createLoopbackToolCallSource(runtime: PluginToolCallRuntime): {
  resolveToolOwner(serverId: string, toolName: string): string | undefined;
  callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
} {
  return {
    // The runtime's method map is global (a method name is owned by exactly one
    // plugin), so the owner is resolved from the NAME alone; the caller compares it
    // against the card's serverId.
    resolveToolOwner: (_serverId, toolName) => runtime.resolveToolOwner(toolName),
    callTool: (_serverId, toolName, args) =>
      runtime.callFromUi(toolName, args, { userAction: false }),
  };
}

/**
 * External source — the card's server is a foreign MCP peer. Its tools are already
 * in the §6.4 registry as GATED `Tool`s (`mcp_<prefix>_<name>`, `category:"network"`,
 * `mcpServerId` set) because `mcp-tool-adapter` put them there, so the call is just
 * an executor invocation over the registry entry the model would use.
 */
export function createExternalToolCallSource(deps: ExternalToolCallDeps): {
  resolveToolOwner(serverId: string, toolName: string): string | undefined;
  callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
} {
  // An app names its server's tools by their SERVER-LOCAL name; the registry knows
  // them namespaced. One lookup, used by both members.
  const lookup = (serverId: string, toolName: string): Tool | undefined =>
    deps.findTool(deps.namespacedToolName(serverId, toolName));

  return {
    // The registry entry's `mcpServerId` is the AUTHORITY on ownership — not the
    // namespacing, which passes an unapproved server's name through unchanged. A
    // host builtin (`bash`) or another server's tool therefore resolves to
    // `undefined` / a different id and is denied by the caller's ONE comparison.
    resolveToolOwner: (serverId, toolName) => lookup(serverId, toolName)?.mcpServerId,

    callTool: async (serverId, toolName, args) => {
      const tool = lookup(serverId, toolName);
      // Unreachable via the IPC handler (its owner check already denied an unknown
      // tool), but this source is the one place that must never invoke blind.
      if (!tool) throw new Error(`Tool not found: ${toolName}`);

      // ── SPEC MUST (external arm) ──────────────────────────────────────────────
      // The host MUST reject an app's `tools/call` for a tool whose
      // `_meta.ui.visibility` does not include "app". `appInvokable` IS that bit,
      // materialized once at ingestion (`mcp-tool-adapter`). Fail-closed on
      // `undefined`: a registry entry that never went through the adapter (a host
      // builtin) is not app-callable. The plugin arm's equivalent is
      // `assertUiActionInvokable` inside `callFromUi` — one enforcement site each,
      // no layering.
      if (tool.appInvokable !== true) {
        throw new Error(
          `Tool '${toolName}' is not app-callable: its _meta.ui.visibility does not include "app"`,
        );
      }

      const invoke = deps.getInvoker();
      if (!invoke) throw new Error("Tool executor is not wired; MCP App tool call denied");

      // The gated path: ToolExecutor → risk classification (`inspectHostRisk`;
      // external MCP ⇒ "network") → reviewer/approval → audit. `origin: "ui"` (a
      // foreground, non-headless call the user can be asked about) +
      // `userAction: false` (see the file header).
      return invoke(tool.name, args, { origin: "ui", userAction: false });
    },
  };
}
