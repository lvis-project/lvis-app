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
 * ── An MCP App is NOT the plugin's trusted panel ───────────────────────────────
 * An MCP App runs in an UNTRUSTED sandboxed iframe. A "the user clicked" claim
 * originating inside it is not verifiable by the host (the renderer's real
 * `navigator.userActivation` belongs to the host frame, not the guest, and the
 * guest can synthesize a call at any time). So an app-initiated call is NEVER
 * marked user-initiated: it must earn its consent from the approval gate like any
 * other non-user-initiated tool call.
 *
 * Because a `userAction` claim is unverifiable here, the app does not get the
 * panel's origin: the loopback source dispatches with `origin: "mcp-app"`
 * (`PluginRuntime.callFromApp`), NOT `origin: "ui"` (`callFromUi`, the plugin's own
 * first-party React panel). The ungoverned app-only plugin dispatch path
 * (`callDeclaredAppOnlyTool`, which skips risk/reviewer/approval/audit) is entered
 * only on a UI-EFFECTIVE chain (`isAppOnlyRuntimeInvocation` returns false for any
 * other origin), so an app-origin call does not enter that path AT ALL — not
 * "enters it and is stopped by a user-activation check". That distinction is the
 * whole fix: the activation check has a carve-out (the manifest's
 * `auth.statusTool`), and a card that could reach the path would slip through it.
 *
 * ── What an app may call: `_meta.ui.visibility` ∋ "app". Nothing else. ────────────
 * Including an APP-ONLY tool (`["app"]`) — the spec's spelling for a tool that
 * serves the CARD and is hidden from the model. Both arms register such a tool as a
 * §6.4 `Tool` (loopback: `plugin-server-projection` → `plugin-tool-from-mcp`;
 * external: `mcp-tool-adapter`), which is what gives the governed executor something
 * to run, and both keep it out of the model's tool list at the registry's one
 * model-exposure boundary. So the SAME declaration means the SAME thing whichever
 * server backs the card — governed, callable, model-invisible. What an app-only tool
 * does NOT get from either arm is the panel's ungoverned dispatch: it is reached
 * through the gate, or not at all.
 */
import type { Tool } from "../tools/base.js";
import type { PluginToolInvocationDelegate } from "../plugins/runtime/index.js";
import { resolvePluginOperation } from "../tools/plugin-operation-governance.js";

export interface McpAppToolInvocation {
  /** Host-minted; the card/renderer cannot choose this authority identity. */
  appSessionId: string;
  /** Host-issued one-shot token, retained inside main and never exposed to the card. */
  operationGrantToken?: string;
  /** Exact immutable plugin generation bound to a loopback card. */
  expectedGenerationId?: string;
}

export interface McpOperationGrantTarget {
  pluginId: string;
  toolName: string;
}

function operationGrantTarget(
  tool: Tool | undefined,
  args: Record<string, unknown>,
): McpOperationGrantTarget | undefined {
  if (!tool?.pluginId || !tool.operationGovernance) return undefined;
  const resolved = resolvePluginOperation(tool.operationGovernance, args, "mcp-app");
  return resolved.rule.kind === "write" && resolved.rule.requiresRead
    ? { pluginId: tool.pluginId, toolName: tool.name }
    : undefined;
}

/** The `PluginRuntime` subset the loopback (first-party plugin) source needs. */
interface PluginToolCallRuntime {
  /** `method → owning pluginId` (a loopback server's id IS its pluginId). */
  resolveToolOwner(method: string): string | undefined;
  /**
   * The gated MCP-App→plugin invocation path (`origin: "mcp-app"`). Enforces
   * `assertUiActionInvokable` (the tool's `_meta.ui.visibility` MUST include
   * `"app"` — the SPEC MUST for this backend, enforced there and nowhere else) and
   * delegates to the ToolExecutor — for every app-visible tool, app-only ones
   * included. It takes no `userAction` argument: an app never has one.
   */
  callFromApp(
    method: string,
    payload?: unknown,
    options?: {
      appSessionId?: string;
      operationGrantToken?: string;
      expectedGenerationId?: string;
    },
  ): Promise<unknown>;
}

export interface LoopbackToolCallDeps {
  runtime: PluginToolCallRuntime;
  /** Canonical registry lookup for the Host-owned operation-policy sidecar. */
  findTool(name: string): Tool | undefined;
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
 * map; the visibility MUST and the gate both live inside `callFromApp`.
 */
export function createLoopbackToolCallSource(deps: LoopbackToolCallDeps): {
  resolveToolOwner(serverId: string, toolName: string): string | undefined;
  resolveOperationGrantTarget(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): McpOperationGrantTarget | undefined;
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    invocation: McpAppToolInvocation,
  ): Promise<unknown>;
} {
  return {
    // The runtime's method map is global (a method name is owned by exactly one
    // plugin), so the owner is resolved from the NAME alone; the caller compares it
    // against the card's serverId.
    resolveToolOwner: (_serverId, toolName) => deps.runtime.resolveToolOwner(toolName),
    resolveOperationGrantTarget: (_serverId, toolName, args) =>
      operationGrantTarget(deps.findTool(toolName), args),
    // `callFromApp`, never `callFromUi` — the app is not the plugin's panel (see
    // the file header). No `userAction` argument exists on this path.
    callTool: (_serverId, toolName, args, invocation) =>
      deps.runtime.callFromApp(toolName, args, invocation),
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
  resolveOperationGrantTarget(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): McpOperationGrantTarget | undefined;
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    invocation: McpAppToolInvocation,
  ): Promise<unknown>;
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

    resolveOperationGrantTarget: (serverId, toolName, args) => {
      const tool = lookup(serverId, toolName);
      if (!tool || tool.mcpServerId !== serverId) return undefined;
      return operationGrantTarget(tool, args);
    },

    callTool: async (serverId, toolName, args, invocation) => {
      const tool = lookup(serverId, toolName);
      // Unreachable via the IPC handler (its owner check already denied an unknown
      // tool), but this source is the one place that must never invoke blind.
      if (!tool) throw new Error(`Tool not found: ${toolName}`);
      if (tool.mcpServerId !== serverId) {
        throw new Error(
          `Tool '${toolName}' owner changed during MCP App call: expected '${serverId}', got '${tool.mcpServerId ?? "unknown"}'`,
        );
      }

      // ── SPEC MUST (external arm) ──────────────────────────────────────────────
      // The host MUST reject an app's `tools/call` for a tool whose
      // `_meta.ui.visibility` does not include "app". `appInvokable` IS that bit,
      // materialized once at ingestion (`mcp-tool-adapter`). Fail-closed on
      // `undefined`: a registry entry that never went through the adapter (a host
      // builtin) is not app-callable. The plugin arm's equivalent is
      // `assertUiActionInvokable` inside `callFromApp` — one enforcement site each,
      // no layering.
      if (tool.appInvokable !== true) {
        throw new Error(
          `Tool '${toolName}' is not app-callable: its _meta.ui.visibility does not include "app"`,
        );
      }

      const invoke = deps.getInvoker();
      if (!invoke) throw new Error("Tool executor is not wired; MCP App tool call denied");

      // The gated path: ToolExecutor → risk classification (`inspectHostRisk`;
      // external MCP ⇒ "network") → reviewer/approval → audit. `origin: "mcp-app"`
      // — the SAME origin the loopback arm uses: a card is a card, whichever server
      // backs it, and neither arm is the trusted panel. It is still a foreground
      // (non-headless) call the user can be asked about; what it is NOT is a call
      // that can claim a user gesture (`userAction` is never set — see the header).
      return invoke(tool.name, args, {
        origin: "mcp-app",
        userAction: false,
        ...(tool.pluginId ? { ownerPluginId: tool.pluginId } : {}),
        appInvocation: {
          surface: "mcp-app",
          sessionId: invocation.appSessionId,
          ...(invocation.operationGrantToken
            ? { operationGrantToken: invocation.operationGrantToken }
            : {}),
        },
        expectedMcpServerId: serverId,
      });
    },
  };
}
