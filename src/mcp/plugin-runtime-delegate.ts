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
 *
 * This is also where a plugin TRIGGERS an MCP App card. A plugin's tool handler
 * says "render this card with my result" by attaching the STANDARD MCP Apps
 * tool-result extension to its return value —
 *
 *   return { ...myResult, _meta: { ui: { resourceUri: "ui://<myId>/card.html" } } };
 *
 * — the same `_meta.ui.*` keys an external MCP server puts on its `CallToolResult`
 * (NOT an `xyz.lvis/*` vendor key), so both arms declare a card identically. The
 * delegate lifts it onto the wire `_meta.ui`, from which `PluginMcpHost.invoke`
 * builds the {@link McpUiPayload} (stamping `serverId` itself — a plugin can never
 * point a card at another server). The declaration is stripped from the value, so
 * the model-facing text and `metadata.rawResult` stay the plugin's own result.
 *
 * Fail-closed: a `resourceUri` the plugin did not declare in `manifest.uiResources[]`
 * produces NO card. `declaredUiUris` is the SAME declared set the serving provider
 * indexes (`PluginUiResourceProvider.list()`) — not a second registry — so a card
 * can only ever be triggered for a uri that is actually servable under a reviewed
 * csp. An absent set (a plugin with no `uiResources[]`) means no card is possible.
 */
import type { PluginRuntime } from "../plugins/runtime.js";
import type { PluginToolDelegate, PluginToolOutcome } from "./plugin-mcp-server.js";
import {
  ManifestIntegrityViolation,
  manifestIntegrityState,
} from "../permissions/manifest-integrity.js";
import { sessionContext } from "../engine/session-context.js";
import { createLogger } from "../lib/logger.js";
import type { McpUiSlot, McpUiToolMeta } from "./types.js";

const log = createLogger("plugin-runtime-delegate");

/** Reserved `_meta` key carrying the plugin's raw (non-text) return value. */
export const RAW_RESULT_META = "xyz.lvis/rawResult";

function errorOutcome(text: string): PluginToolOutcome {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Split a plugin tool's return value into (the plugin's own result, the MCP Apps
 * card declaration it attached). Pure.
 *
 * A card is declared iff the value is a plain object carrying `_meta.ui` with a
 * non-empty string `resourceUri` — the MCP wire shape. When it is, `_meta` is
 * stripped from the value so the protocol envelope never leaks into the text the
 * model reads or into `metadata.rawResult`. Any other shape (string, array, no
 * `_meta`, malformed `ui`) passes through untouched: no card, value unchanged.
 *
 * `slot` is passed through with the same cast `mcp-client.ts` applies to an
 * external server's `_meta.ui.slot`, deliberately — both arms must behave
 * identically, and the render slot is a hint, not a security boundary.
 */
export function splitPluginToolUiMeta(value: unknown): { value: unknown; ui?: McpUiToolMeta } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { value };
  const record = value as Record<string, unknown>;
  const meta = record._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return { value };
  const rawUi = (meta as Record<string, unknown>).ui;
  if (typeof rawUi !== "object" || rawUi === null || Array.isArray(rawUi)) return { value };

  const { resourceUri, slot, height, title } = rawUi as Record<string, unknown>;
  if (typeof resourceUri !== "string" || resourceUri.length === 0) return { value };

  const ui: McpUiToolMeta = { resourceUri };
  if (typeof slot === "string") ui.slot = slot as McpUiSlot;
  if (typeof height === "number" && Number.isFinite(height)) ui.height = height;
  if (typeof title === "string") ui.title = title;

  // The declaration is protocol, not payload — strip it either way (whether or not
  // the uri survives the declared-only gate), so the result the model sees never
  // depends on whether the card rendered.
  const { _meta: _protocol, ...rest } = record;
  return { value: rest, ui };
}

/**
 * Build the `tools/call` delegate for one first-party plugin. Mirrors
 * `buildPluginTool`'s execute closure exactly (gates, messages, result shape),
 * but at the MCP server boundary instead of the legacy direct Tool.
 */
export function pluginRuntimeToolDelegate(
  pluginRuntime: PluginRuntime,
  pluginId: string,
  /**
   * The `ui://` uris this plugin declared in `manifest.uiResources[]` — the same
   * set its serving provider indexes. A card is emitted only for a uri in here.
   * Defaults to empty: a plugin that declares no card cannot trigger one.
   */
  declaredUiUris: ReadonlySet<string> = new Set(),
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
      const returned = await pluginRuntime.call(toolName, finalPayload);
      // The plugin's own result, and (optionally) the card it asked the host to
      // render with it — the standard MCP Apps `_meta.ui` tool-result extension.
      const { value: result, ui } = splitPluginToolUiMeta(returned);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);

      const meta: Record<string, unknown> = { [RAW_RESULT_META]: result };
      if (ui) {
        // Declared-only, fail-closed: a card the manifest never declared is not
        // servable under any reviewed csp, so it must not render at all.
        if (declaredUiUris.has(ui.resourceUri)) {
          meta.ui = ui;
        } else {
          log.warn(
            `plugin '${pluginId}' tool '${toolName}' requested ui resource '${ui.resourceUri}' ` +
              `which it did not declare in manifest.uiResources[] — no card rendered`,
          );
        }
      }
      return { content: [{ type: "text", text }], _meta: meta };
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
