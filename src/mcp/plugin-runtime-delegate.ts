/**
 * Bridges a {@link PluginRuntime} into the {@link PluginToolDelegate} a
 * {@link PluginMcpServer} calls for `tools/call`. This is where the loopback
 * (plugin-as-MCP-server) path preserves EXACT parity with the legacy
 * `buildPluginTool` execute gate (`plugins/plugin-tool-adapter.ts`): the same
 * fail-closed runtime-state gates run BEFORE the plugin is invoked —
 *
 *  - inactive plugin → isError. A sub-agent's `sourceTools` allowlist is NOT
 *    `isPluginEnabled`-filtered, so this is the authoritative execution gate for
 *    every model path, not merely UI hiding.
 *  - manifest-integrity-disabled plugin → isError.
 *  - {@link ManifestIntegrityViolation} thrown by the read-only fs proxy →
 *    record the violation (so later calls fail closed + audit + UI emit fire) →
 *    isError.
 *
 * The structured plugin return value is carried back as
 * `_meta["lvisai/rawResult"]` (the reverse adapter re-surfaces it as
 * `metadata.rawResult`) so the executor.ts / boot.ts consumers that read the raw
 * value keep working — MCP's content model is text-first, so non-text structured
 * output rides `_meta`. Parity invariant: rawResult is present iff the call
 * succeeded (the legacy adapter sets `metadata.rawResult` only on the success
 * branch).
 */
import type { PluginRuntime } from "../plugins/runtime.js";
import type { PluginToolDelegate, PluginToolOutcome } from "./plugin-mcp-server.js";
import {
  ManifestIntegrityViolation,
  manifestIntegrityState,
} from "../permissions/manifest-integrity.js";
import { sessionContext } from "../engine/session-context.js";

/** Reserved `_meta` key carrying the plugin's raw (non-text) return value. */
export const RAW_RESULT_META = "lvisai/rawResult";

function errorOutcome(text: string): PluginToolOutcome {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Build the `tools/call` delegate for one first-party plugin. Mirrors
 * `buildPluginTool`'s execute closure exactly (gates, messages, result shape),
 * but at the MCP server boundary instead of the legacy direct Tool.
 */
export function pluginRuntimeToolDelegate(
  pluginRuntime: PluginRuntime,
  pluginId: string,
): PluginToolDelegate {
  return async (toolName, args): Promise<PluginToolOutcome> => {
    // Mirror buildPluginTool: empty args → undefined payload (some plugins
    // distinguish "no args" from an empty object).
    const finalPayload = Object.keys(args).length > 0 ? args : undefined;

    // Gate 4 (authoritative execution gate): allow the call if the plugin is
    // registry-enabled OR session-activated for the CALLING session.
    //
    // Session activation is set by ConversationLoop after `request_plugin`
    // clears the allow-list gate in a routine session — it is NEVER persistent
    // (setPluginEnabled is not called; registry remains enabled:false).
    //
    // The calling session ID is read from AsyncLocalStorage (set by
    // ConversationLoop.runTurn around this.queryLoop). Per-session scoping
    // guarantees that clearing session B (e.g. user starts a new main-chat
    // conversation) never wipes session A's activation (e.g. an in-flight
    // routine that activated local-indexer at 22:00).
    //
    // Fail-closed: if no session context is present (e.g. an out-of-band
    // call from tests without ALS context), `sessionId` is undefined and the
    // gate refuses — safe default.
    const sessionId = sessionContext.getStore()?.sessionId;
    if (
      !pluginRuntime.isPluginEnabled(pluginId) &&
      !(sessionId !== undefined && pluginRuntime.isSessionActivated(sessionId, pluginId))
    ) {
      return errorOutcome(
        `Plugin '${pluginId}' is inactive; tool '${toolName}' is unavailable ` +
          `until the plugin is re-enabled.`,
      );
    }
    if (manifestIntegrityState.isDisabled(pluginId)) {
      return errorOutcome(
        `Plugin '${pluginId}' was disabled after a manifest integrity violation. Reinstall the plugin ` +
          `to re-enable.`,
      );
    }

    try {
      const result = await pluginRuntime.call(toolName, finalPayload);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return {
        content: [{ type: "text", text }],
        _meta: { [RAW_RESULT_META]: result },
      };
    } catch (err) {
      if (err instanceof ManifestIntegrityViolation) {
        let violationAuditError: unknown;
        try {
          await manifestIntegrityState.recordViolation(
            err.pluginId,
            err.toolName,
            err.attemptedMethod,
          );
        } catch (auditErr) {
          violationAuditError = auditErr;
        }
        return errorOutcome(
          violationAuditError
            ? `${err.message}\nManifest violation audit failed: ${violationAuditError instanceof Error ? violationAuditError.message : String(violationAuditError)}`
            : err.message,
        );
      }
      return errorOutcome(err instanceof Error ? err.message : String(err));
    }
  };
}
