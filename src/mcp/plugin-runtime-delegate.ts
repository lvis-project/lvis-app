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
 * `_meta["xyz.lvis/rawResult"]` (the reverse adapter re-surfaces it as
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

/** Reserved `_meta` key carrying the plugin's raw (non-text) return value. */
export const RAW_RESULT_META = "xyz.lvis/rawResult";

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

    if (!pluginRuntime.isPluginEnabled(pluginId)) {
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
