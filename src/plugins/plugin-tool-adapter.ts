/**
 * Plugin Tool Adapter — bridges plugin manifest `tools[]` declarations into
 * the canonical {@link Tool} contract used by the §6.4 ToolRegistry.
 *
 * v1.3: dispatches by `executionType` ("command" | "subagent").
 * "background" was removed — fire-and-forget is an LLM-chosen per-call option
 * (runInBackground in subagent input schema), not a static manifest type.
 * Scheduled execution uses PluginManifest.schedule[] (separate concern).
 * Legacy `methods[]`-only plugins fall back to the generic payload schema.
 *
 * Ref: LVIS Plugin Tool Schema Design §5 (docs/references/plugin-tool-schema-design.md)
 */
import { createDynamicTool, type Tool } from "../tools/base.js";
import type { PluginRuntime } from "./runtime.js";
import type {
  PluginManifest,
  PluginToolDefinition,
  PluginToolAnnotations,
  PluginToolExample,
} from "./types.js";

// ─── Description synthesis ──────────────────────────────────────────────────

function synthesizeDescription(def: PluginToolDefinition): string {
  const parts: string[] = [def.description];

  if (def.outputDescription) {
    parts.push(`\nOutput: ${def.outputDescription}`);
  }

  if (def.examples && def.examples.length > 0) {
    const exLines = def.examples
      .map((ex: PluginToolExample) => {
        const inp = JSON.stringify(ex.input);
        const base = ex.description ? `${ex.description}: input=${inp}` : `input=${inp}`;
        return ex.output !== undefined
          ? `  - ${base}, output=${JSON.stringify(ex.output)}`
          : `  - ${base}`;
      })
      .join("\n");
    parts.push(`\nExamples:\n${exLines}`);
  }

  if (def.executionType === "subagent") {
    const bg = def.subagent?.allowBackground
      ? " runInBackground:true를 전달하면 즉시 taskId를 반환하고 백그라운드에서 실행합니다."
      : "";
    parts.push(`\n[내부 LLM 서브에이전트를 사용합니다. 완료까지 여러 턴이 소요될 수 있습니다.${bg}]`);
  }

  return parts.join("");
}

// ─── isReadOnly helper ───────────────────────────────────────────────────────

function resolveReadOnly(annotations?: PluginToolAnnotations): boolean {
  return annotations?.readOnlyHint === true;
}

// ─── inputSchema with fallback ───────────────────────────────────────────────

function resolveInputSchema(def: PluginToolDefinition): object {
  if (def.inputSchema) return def.inputSchema;
  return {
    type: "object",
    properties: {
      payload: {
        type: "object",
        description: "메서드에 전달할 매개변수 객체",
      },
    },
  };
}

// ─── Tool builders ───────────────────────────────────────────────────────────

function buildCommandTool(
  pluginRuntime: PluginRuntime,
  def: PluginToolDefinition,
  pluginId: string,
): Tool {
  const readOnly = resolveReadOnly(def.annotations);
  return createDynamicTool({
    name: def.name,
    description: synthesizeDescription(def),
    source: "plugin",
    pluginId,
    jsonSchema: resolveInputSchema(def),
    isReadOnly: () => readOnly,
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      // If LLM passed a flat object matching inputSchema fields, use directly.
      // If it passed {payload: ...}, extract payload.
      const payload = def.inputSchema
        ? args
        : (args.payload ?? (Object.keys(args).length > 0 ? args : undefined));
      try {
        const result = await pluginRuntime.call(def.name, payload);
        return {
          output: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          isError: false,
        };
      } catch (err) {
        return {
          output: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  });
}

/**
 * Build subagent input schema with optional runInBackground injection.
 * Only injects when base schema is an object-typed schema — avoids polluting
 * non-object schemas (string/array/oneOf). Returns unmodified schema when the
 * plugin has not opted in via `subagent.allowBackground`.
 */
function buildSubagentInputSchema(def: PluginToolDefinition): object {
  const base = resolveInputSchema(def);
  if (!def.subagent?.allowBackground) return base;
  const baseObj = base as Record<string, unknown>;
  if (baseObj.type !== "object") {
    console.warn(
      `[plugin-tool-adapter] ${def.name}: allowBackground requested but inputSchema is not type:"object"; runInBackground not injected.`,
    );
    return base;
  }
  const props = { ...((baseObj.properties as Record<string, unknown>) ?? {}) };
  props.runInBackground = {
    type: "boolean",
    description: "true로 설정하면 서브에이전트를 백그라운드에서 실행하고 taskId를 즉시 반환합니다.",
  };
  return { ...baseObj, properties: props };
}

function buildSubagentTool(
  pluginRuntime: PluginRuntime,
  def: PluginToolDefinition,
  pluginId: string,
): Tool {
  return createDynamicTool({
    name: def.name,
    description: synthesizeDescription(def),
    source: "plugin",
    pluginId,
    jsonSchema: buildSubagentInputSchema(def),
    isReadOnly: () => resolveReadOnly(def.annotations),
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      // Extract and strip runInBackground from payload — plugin handlers must not
      // receive this meta-field. It is a subagent-runtime directive consumed by
      // hostApi.spawnSubagent (P2). Until P2 lands, a truthy value returns a clear
      // "not implemented" error so the LLM does not silently degrade to sync.
      const { runInBackground, ...payload } = args;
      if (runInBackground === true) {
        return {
          output: "서브에이전트 백그라운드 실행은 아직 구현되지 않았습니다 (P2 대기). runInBackground 없이 재시도하세요.",
          isError: true,
        };
      }
      // Sync subagent path: P2 SubagentRunner will route through hostApi.spawnSubagent.
      // Phase 1 fallback: delegate to plugin handler (logged so mis-wiring is visible).
      try {
        const result = await pluginRuntime.call(def.name, payload);
        return {
          output: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          isError: false,
        };
      } catch (err) {
        return {
          output: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  });
}

// ─── Generic fallback (legacy methods[]) ─────────────────────────────────────

/** @deprecated Use pluginToolsForRegistration() with manifest.tools[] instead. */
export function pluginMethodToTool(
  pluginRuntime: PluginRuntime,
  methodName: string,
): Tool {
  return createDynamicTool({
    name: methodName,
    description: `플러그인 메서드: ${methodName}. payload에 필요한 매개변수를 JSON 객체로 전달하세요.`,
    source: "plugin",
    jsonSchema: {
      type: "object",
      properties: {
        payload: {
          type: "object",
          description: "메서드에 전달할 매개변수 객체",
        },
      },
    },
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      let finalPayload: unknown = args.payload;
      if (!finalPayload && Object.keys(args).length > 0) finalPayload = args;
      if (typeof finalPayload === "string") {
        try { finalPayload = JSON.parse(finalPayload); } catch { /* leave as string */ }
      }
      try {
        const result = await pluginRuntime.call(methodName, finalPayload);
        return {
          output: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          isError: false,
        };
      } catch (err) {
        return {
          output: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  });
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Build all Tool instances for a plugin, dispatching by executionType.
 *
 * Resolution order per method name:
 *  1. tools[] entry with matching name → typed dispatch (command/subagent)
 *  2. methods[] entry without tools[] match → generic {payload: object} fallback
 *
 * @param pluginRuntime - The plugin runtime instance
 * @param pluginId      - Plugin identifier for ToolRegistry tagging
 * @param manifest      - Plugin manifest (may include tools[] and/or methods[])
 */
export function pluginToolsForRegistration(
  pluginRuntime: PluginRuntime,
  pluginId: string,
  manifest: PluginManifest,
): Tool[] {
  const tools: Tool[] = [];
  const declared = new Map<string, PluginToolDefinition>();

  // Index tools[] by name
  for (const def of manifest.tools ?? []) {
    declared.set(def.name, def);
  }

  // Build typed tools from tools[]
  for (const def of manifest.tools ?? []) {
    let tool: Tool;
    // Legacy v1.2 support: `executionType: "background"` was removed in v1.3.
    // Manifest schema now rejects the enum value, but defensively detect it here
    // for any bypass paths (unvalidated manifests) and emit an upgrade hint.
    const execType = def.executionType as string;
    if (execType === "background") {
      console.warn(
        `[plugin-tool-adapter] ${pluginId}/${def.name}: executionType:"background" is removed in v1.3. Migrate to executionType:"subagent" + subagent.allowBackground:true, or declare a host-managed manifest.schedule[] entry. Falling back to "command" for now.`,
      );
      tool = buildCommandTool(pluginRuntime, def, pluginId);
      tools.push(tool);
      continue;
    }
    switch (def.executionType) {
      case "subagent":
        tool = buildSubagentTool(pluginRuntime, def, pluginId);
        break;
      case "command":
      default:
        tool = buildCommandTool(pluginRuntime, def, pluginId);
        break;
    }
    tools.push(tool);
  }

  // Fallback: methods[] entries not covered by tools[]
  for (const method of manifest.methods ?? []) {
    if (!declared.has(method)) {
      tools.push(pluginMethodToTool(pluginRuntime, method));
    }
  }

  return tools;
}
