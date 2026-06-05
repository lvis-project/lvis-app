/**
 * Plugin Tool Adapter — bridges plugin `tools[]` declarations into the
 * canonical {@link Tool} contract used by the §6.4 ToolRegistry.
 *
 * Uses `manifest.toolSchemas[tool]` so the LLM sees typed parameter fields.
 * Plugin authority is SDK-schema-first: category and pathFields are read only
 * from the manifest schema contract. The app does not infer plugin authority
 * from plugin ids, tool names, or legacy helper maps.
 */
import { createDynamicTool, type Tool } from "../tools/base.js";
import type { ToolCategory } from "../tools/types.js";
import type { PluginRuntime } from "./runtime.js";
import type { PluginManifest } from "./types.js";
import { plog, PluginPhase } from "./lifecycle-log.js";
import { lintToolInputSchema } from "./tool-schema-lint.js";
import {
  ManifestIntegrityViolation,
  manifestIntegrityState,
} from "../permissions/manifest-integrity.js";
import { t } from "../i18n/index.js";

interface ToolSchemaEntry {
  description?: string;
  category?: Exclude<ToolCategory, "meta">;
  pathFields?: string[];
  /**
   * Issue #664 P1 — manifest-declared sandbox-write self-attestation.
   * When true AND the runtime verifies path containment under the
   * owning plugin's sandbox root (`~/.lvis/plugins/<pluginId>/`),
   * the reviewer auto-LOWs the verdict so plugin tools can touch
   * their own data dir without round-tripping the user.
   */
  writesToOwnSandbox?: boolean;
  /** §6.4 Tool versioning — optional per-tool semver. Falls back to manifest.version. */
  version?: string;
  deprecatedSince?: string;
  replacedBy?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Returns true only when the supplied schema is a well-formed object schema
 * the LLM can consume directly. Anything else (string type, missing
 * properties, non-object root) is rejected instead of silently shipping a
 * broken schema.
 */
function isValidTypedSchema(schema: Record<string, unknown> | undefined): boolean {
  if (!schema || typeof schema !== "object") return false;
  if (schema.type !== "object") return false;
  const props = schema.properties;
  return typeof props === "object" && props !== null;
}

function typedDescription(toolName: string): string {
  return t("be_pluginToolAdapter.typedDescription", { toolName });
}

function buildPluginTool(
  pluginRuntime: PluginRuntime,
  toolName: string,
  pluginId: string,
  schemaEntry: ToolSchemaEntry | undefined,
  manifestVersion: string,
): Tool {
  if (!schemaEntry || !isValidTypedSchema(schemaEntry.inputSchema)) {
    throw new Error(
      `Invalid plugin tool schema for '${toolName}': inputSchema must be an object schema with properties`,
    );
  }
  if (!schemaEntry.category) {
    throw new Error(
      `Invalid plugin tool schema for '${toolName}': category is required by the SDK authority metadata contract`,
    );
  }
  const typed = schemaEntry.inputSchema;
  const description = schemaEntry.description ?? typedDescription(toolName);
  return createDynamicTool({
    name: toolName,
    description,
    source: "plugin",
    category: schemaEntry.category,
    pluginId,
    pathFields: schemaEntry.pathFields,
    writesToOwnSandbox: schemaEntry.writesToOwnSandbox,
    version: schemaEntry?.version ?? manifestVersion,
    deprecatedSince: schemaEntry?.deprecatedSince,
    replacedBy: schemaEntry?.replacedBy,
    jsonSchema: typed,
    isReadOnly: () => schemaEntry.category === "read",
    execute: async (rawInput) => {
      plog("debug", { pluginId, phase: PluginPhase.INVOKE_START, toolName, inputType: typeof rawInput, inputKeys: rawInput !== null && typeof rawInput === "object" ? Object.keys(rawInput as object).length : 0 }, "tool invocation start");
      // Some provider paths deliver tool arguments pre-serialized. Parse once
      // at the entry point so the plugin receives the declared object shape.
      let parsed: unknown = rawInput ?? {};
      if (typeof parsed === "string") {
        try { parsed = JSON.parse(parsed); } catch { /* leave as string */ }
      }
      const args = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;

      const finalPayload = Object.keys(args).length > 0 ? args : undefined;
      // Active/inactive execution gate. An inactive plugin's tools stay
      // registered so host auth/config/UI flows keep calling
      // pluginRuntime.call() directly, and the main agent's schema set already
      // hides them via resolveToolScope — but a sub-agent's sourceTools
      // allowlist is NOT filtered by isPluginEnabled, so this adapter is the
      // authoritative fail-closed gate for every model/agent execution path.
      if (!pluginRuntime.isPluginEnabled(pluginId)) {
        return {
          output:
            `Plugin '${pluginId}' is inactive; tool '${toolName}' is unavailable ` +
            `until the plugin is re-enabled.`,
          isError: true,
        };
      }
      // Permission policy P4 §3.5 — manifest integrity guard. SDK manifest
      // metadata is the authority for category/pathFields; if any host→plugin
      // fs boundary reports a manifest-integrity violation, this
      // post-violation gate prevents the disabled plugin from running new calls.
      if (manifestIntegrityState.isDisabled(pluginId)) {
        return {
          output:
            `Plugin '${pluginId}' was disabled after a manifest integrity violation. Reinstall the plugin ` +
            `to re-enable.`,
          isError: true,
        };
      }
      try {
        const result = await pluginRuntime.call(toolName, finalPayload);
        plog("debug", { pluginId, phase: PluginPhase.INVOKE_OK, toolName }, "tool invocation ok");
        return {
          output: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          isError: false,
          metadata: { rawResult: result },
        };
      } catch (err) {
        // Permission policy P4 §3.5 — capture manifest-integrity violations: the
        // plugin's tool used the read-only fs proxy and the proxy
        // threw. Record the violation so subsequent calls fail closed
        // and audit + UI emit fire.
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
          plog(
            "warn",
            { pluginId, phase: PluginPhase.INVOKE_FAIL, toolName, err, auditErr: violationAuditError },
            "manifest integrity violation",
          );
          return {
            output: violationAuditError
              ? `${err.message}\nManifest violation audit failed: ${violationAuditError instanceof Error ? violationAuditError.message : String(violationAuditError)}`
              : err.message,
            isError: true,
          };
        }
        plog("warn", { pluginId, phase: PluginPhase.INVOKE_FAIL, toolName, err }, "tool invocation failed");
        return {
          output: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  });
}

export function pluginToolsForRegistration(
  pluginRuntime: PluginRuntime,
  pluginId: string,
  manifest: PluginManifest,
): Tool[] {
  const schemas = manifest.toolSchemas ?? {};
  const manifestVersion = manifest.version || "1.0.0";
  const tools: Tool[] = [];
  for (const tool of manifest.tools ?? []) {
    const schemaEntry = schemas[tool];

    // Build FIRST: structural / authority failures (non-object schema, missing
    // category) throw here, which boot relies on to fail closed (keep the
    // previous registry on an invalid manifest). Building before the lint means
    // a tool with a hard error is never silently dropped — it still throws even
    // if it would also trip the lint (e.g. a root `type:"array"`).
    const built = buildPluginTool(pluginRuntime, tool, pluginId, schemaEntry, manifestVersion);

    // #1182 — THEN provider-strict lint, fail-soft per tool. A structurally
    // valid schema OpenAI/Azure would still 400 on (e.g. an `array` property
    // without `items`) is dropped so it can't take down the whole turn for
    // every flow that loads this plugin. Pure structural lint, plugin-agnostic.
    const violations = lintToolInputSchema(schemaEntry?.inputSchema);
    if (violations.length > 0) {
      plog(
        "warn",
        { pluginId, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName: tool, violations },
        "dropping plugin tool: inputSchema fails LLM provider-strict lint",
      );
      continue;
    }

    tools.push(built);
  }
  return tools;
}
