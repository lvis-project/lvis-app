/**
 * Plugin Tool Adapter — bridges plugin `tools[]` declarations into the
 * canonical {@link Tool} contract used by the §6.4 ToolRegistry.
 *
 * Uses `manifest.toolSchemas[tool]` so the LLM sees typed parameter fields.
 * Permission category and pathFields integrity are enforced here as the
 * runtime registration choke point.
 */
import { createDynamicTool, type Tool } from "../tools/base.js";
import type { ToolCategory } from "../tools/types.js";
import type { PluginRuntime } from "./runtime.js";
import type { PluginManifest } from "./types.js";
import { plog, PluginPhase } from "./lifecycle-log.js";
import {
  ManifestIntegrityViolation,
  manifestIntegrityState,
} from "../permissions/manifest-integrity.js";

interface ToolSchemaEntry {
  description?: string;
  category?: ToolCategory;
  /** §6.4 Tool versioning — optional per-tool semver. Falls back to manifest.version. */
  version?: string;
  deprecatedSince?: string;
  replacedBy?: string;
  pathFields?: unknown;
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
  return `플러그인 도구: ${toolName}. inputSchema에 선언된 필드를 평면 객체로 전달하세요.`;
}

/**
 * Permission policy — current SDK manifests do not expose a tool authority
 * category. Until the SDK schema grows that SOT field, plugin tools are treated
 * as mutating host-boundary calls. If an in-memory test/future manifest object
 * supplies a category, enforce the closed plugin-owned set.
 */
function normalizeToolCategory(toolName: string, entry: ToolSchemaEntry | undefined): ToolCategory {
  const c = entry?.category;
  if (c === undefined) return "write";
  if (c === "read" || c === "shell" || c === "network") return c;
  if (c === "write") return "write";
  throw new Error(
    `Invalid plugin tool schema for '${toolName}': category must be one of read, write, shell, network`,
  );
}

function normalizePathFields(toolName: string, pathFields: unknown): string[] | undefined {
  if (pathFields === undefined) return undefined;
  if (!Array.isArray(pathFields)) {
    throw new Error(
      `Invalid plugin tool schema for '${toolName}': pathFields must be an array of inputSchema property names`,
    );
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (let i = 0; i < pathFields.length; i += 1) {
    const field = pathFields[i];
    if (typeof field !== "string" || field.length === 0) {
      throw new Error(
        `Invalid plugin tool schema for '${toolName}': pathFields[${i}] must be a non-empty string`,
      );
    }
    if (!seen.has(field)) {
      seen.add(field);
      normalized.push(field);
    }
  }
  return normalized.length > 0 ? normalized : undefined;
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
  const typed = schemaEntry.inputSchema;
  const description = schemaEntry.description ?? typedDescription(toolName);
  const category = normalizeToolCategory(toolName, schemaEntry);
  return createDynamicTool({
    name: toolName,
    description,
    source: "plugin",
    category,
    pluginId,
    version: schemaEntry?.version ?? manifestVersion,
    deprecatedSince: schemaEntry?.deprecatedSince,
    replacedBy: schemaEntry?.replacedBy,
    pathFields: normalizePathFields(toolName, schemaEntry?.pathFields),
    jsonSchema: typed,
    isReadOnly: () => category === "read",
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
      // Permission policy P4 §3.5 — manifest integrity guard.
      // For read-declared tools, fail-deny if the plugin already
      // violated its declaration (caller must reinstall). The proxy
      // itself lives at the host→plugin fs boundary; this check is
      // the *post-violation gate* that prevents the disabled plugin
      // from running new calls.
      if (category === "read" && manifestIntegrityState.isDisabled(pluginId)) {
        return {
          output:
            `Plugin '${pluginId}' was disabled after violating its manifest ` +
            `(declared category=read but attempted a write). Reinstall the plugin ` +
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
        };
      } catch (err) {
        // Permission policy P4 §3.5 — capture manifest-integrity violations: the
        // plugin's tool used the read-only fs proxy and the proxy
        // threw. Record the violation so subsequent calls fail closed
        // and audit + UI emit fire.
        if (err instanceof ManifestIntegrityViolation) {
          manifestIntegrityState.recordViolation(
            err.pluginId,
            err.toolName,
            err.attemptedMethod,
          );
          plog(
            "warn",
            { pluginId, phase: PluginPhase.INVOKE_FAIL, toolName, err },
            "manifest integrity violation",
          );
          return {
            output: err.message,
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
  return (manifest.tools ?? []).map((tool) =>
    buildPluginTool(pluginRuntime, tool, pluginId, schemas[tool], manifestVersion),
  );
}
