/**
 * Tool-exposure metrics + provider-request diagnostics.
 *
 * `buildToolExposureMetrics` and `buildProviderRequestDiagnostics`, extracted
 * from `conversation-loop.ts` with their private source-count helpers.
 */
import type { GenericMessage, LLMVendor, ToolSchema } from "../llm/types.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import type { ToolSource } from "../../tools/types.js";
import type { RequestInputProjection } from "../request-input-projection.js";
import { estimateMessagesTokens, estimateTokens, getModelPreflightThreshold } from "../auto-compact.js";
import type {
  ProviderRequestDiagnostics,
  ToolExposureMetrics,
  ToolScope,
  ToolSourceCounts,
} from "./types.js";

function emptyToolSourceCounts(): ToolSourceCounts {
  return { builtin: 0, plugin: 0, mcp: 0 };
}

function incrementToolSourceCounts(
  counts: ToolSourceCounts,
  source: ToolSource,
): void {
  counts[source] += 1;
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

export function buildToolExposureMetrics(
  toolRegistry: ToolRegistry,
    scope: ToolScope,
    toolSchemas: ToolSchema[],
    projection: RequestInputProjection | null,
    promotedToolNames: readonly string[] = [],
  ): ToolExposureMetrics {
    const loadedEntries = toolRegistry.getToolSchemasForScope(scope);
    const catalogEntries = toolRegistry.getToolCatalogForScope(scope);
    const loadedToolSourceCounts = emptyToolSourceCounts();
    for (const entry of loadedEntries) incrementToolSourceCounts(loadedToolSourceCounts, entry.source);
    const deferredCatalogSourceCounts = { plugin: 0, mcp: 0 };
    for (const entry of catalogEntries) {
      if (entry.source === "plugin") deferredCatalogSourceCounts.plugin += 1;
      if (entry.source === "mcp") deferredCatalogSourceCounts.mcp += 1;
    }
    // Deferral effectiveness — only plugin/MCP tools are deferral-eligible;
    // builtins always load so they must not enter the ratio. The denominator
    // is the full deferral-eligible universe (loaded + still-deferred).
    const deferralEligibleLoadedCount = loadedToolSourceCounts.plugin + loadedToolSourceCounts.mcp;
    const deferralEligibleTotal = deferralEligibleLoadedCount + catalogEntries.length;
    const deferredLoadedRatio =
      deferralEligibleTotal > 0 ? catalogEntries.length / deferralEligibleTotal : null;
    return {
      loadedToolCount: toolSchemas.length,
      loadedToolSourceCounts,
      deferredCatalogCount: catalogEntries.length,
      deferredCatalogSourceCounts,
      promotedToolNames: [...new Set(promotedToolNames)],
      loadedPluginIds: uniqueDefined(loadedEntries.map((entry) => entry.pluginId)),
      loadedMcpServerIds: uniqueDefined(loadedEntries.map((entry) => entry.mcpServerId)),
      deferredPluginIds: uniqueDefined(catalogEntries.map((entry) => entry.pluginId)),
      deferredMcpServerIds: uniqueDefined(catalogEntries.map((entry) => entry.mcpServerId)),
      toolSchemaTokens: projection?.toolSchemaTokens
        ?? estimateTokens(JSON.stringify({ tools: toolSchemas })),
      projectedRequestInputTokens: projection?.totalTokens ?? null,
      deferralEligibleLoadedCount,
      deferredLoadedRatio,
    };
  }

export function buildProviderRequestDiagnostics(sessionId: string, params: {
    round: number;
    assistantRoundIndex: number;
    inputOrigin: ChatInputOrigin;
    configuredProvider: LLMVendor;
    model: string;
    systemPrompt: string;
    messages: GenericMessage[];
    toolSchemas: ToolSchema[];
    activePluginIds: string[];
    projection: RequestInputProjection;
    toolExposure: ToolExposureMetrics;
  }): ProviderRequestDiagnostics {
    const messageRoleCounts: Record<GenericMessage["role"], number> = {
      user: 0,
      assistant: 0,
      tool_result: 0,
    };
    let toolResultChars = 0;
    let compactedToolResultCount = 0;
    let truncatedToolResultCount = 0;
    let serializedStubToolResultCount = 0;
    let assistantToolCallCount = 0;
    const toolResultMessages: GenericMessage[] = [];

    for (const message of params.messages) {
      messageRoleCounts[message.role] += 1;
      if (message.role === "assistant") {
        assistantToolCallCount += message.toolCalls?.length ?? 0;
      }
      if (message.role === "tool_result") {
        toolResultMessages.push(message);
        toolResultChars += message.content.length;
        if (message.meta?.compactedAt !== undefined) compactedToolResultCount += 1;
        if (message.meta?.truncated !== undefined) truncatedToolResultCount += 1;
        if (message.meta?.serializedStub === true) serializedStubToolResultCount += 1;
      }
    }

    const loadedToolNames = params.toolSchemas.map((schema) => schema.name);
    const visibleLoadedToolNames = loadedToolNames.slice(0, 40);
    return {
      sessionId: sessionId,
      round: params.round,
      assistantRoundIndex: params.assistantRoundIndex,
      inputOrigin: params.inputOrigin,
      configuredProvider: params.configuredProvider,
      model: params.model,
      preflightThresholdTokens: getModelPreflightThreshold(
        params.configuredProvider,
        params.model,
      ),
      promptChars: params.systemPrompt.length,
      messageCount: params.messages.length,
      messageRoleCounts,
      projection: params.projection,
      toolResultCount: toolResultMessages.length,
      toolResultChars,
      toolResultTokens: estimateMessagesTokens(toolResultMessages),
      compactedToolResultCount,
      truncatedToolResultCount,
      serializedStubToolResultCount,
      assistantToolCallCount,
      loadedToolNames: visibleLoadedToolNames,
      loadedToolNamesTruncated: Math.max(0, loadedToolNames.length - visibleLoadedToolNames.length),
      activePluginIds: params.activePluginIds,
      toolExposure: params.toolExposure,
    };
  }
