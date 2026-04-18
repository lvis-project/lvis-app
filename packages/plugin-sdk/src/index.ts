/**
 * @lvis/plugin-sdk — type-only public surface of the LVIS plugin contract.
 *
 * Plugin repos import their contract from this single entry point so the
 * host's type updates propagate via a standard npm/bun dependency rather
 * than cross-repo copy/paste.
 *
 * This file mirrors the exports of `lvis-app/src/plugins/types.ts`. Keep
 * them in lock-step — the sdk is a read-only view over the host contract.
 */

export type DeploymentMode = "managed" | "user";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  entry: string;
  tools: string[];
  /**
   * LLM이 도구를 호출할 때 사용하는 JSON Schema (draft-07).
   * 키: tool 이름 (tools 배열 내 값과 동일), 값: { description, inputSchema }
   */
  toolSchemas?: Record<
    string,
    {
      description: string;
      inputSchema: {
        $schema?: string;
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
    }
  >;
  startupTools?: string[];
  /**
   * Optional hard startup timeout (ms, positive integer). Host enforces via
   * Promise.race; slow plugins are fail-soft dropped without cancellation.
   */
  startupTimeoutMs?: number;
  eventSubscriptions?: string[];
  keywords?: Array<{ keyword: string; skillId: string }>;
  capabilities?: string[];
  notificationEvents?: Array<{
    event: string;
    titleField?: string;
    bodyField?: string;
  }>;
  ui?: PluginUiExtension[];
  config?: Record<string, unknown>;
  deployment?: DeploymentMode;
  publisher?: string;
}

export interface PluginUiExtension {
  id: string;
  slot: "sidebar";
  kind: "embedded-module" | "embedded-page" | "info-card";
  displayName?: string;
  title: string;
  description?: string;
  defaults?: Record<string, unknown>;
  entry?: string;
  exportName?: string;
  page?: string;
}

export interface PluginHostApi {
  registerKeywords(keywords: Array<{ keyword: string; skillId: string }>): void;
  emitEvent(eventType: string, data?: unknown): void;
  onEvent(eventType: string, handler: (data: unknown) => void): void;
  addTask(task: {
    title: string;
    description?: string;
    source: string;
    sourceRef?: string;
    priority?: "high" | "medium" | "low";
  }): void;
  saveNote(title: string, content: string): void;
  getSecret(key: string): string | null;

  // Microsoft Graph
  getMsGraphToken(): Promise<string | null>;
  startMsGraphAuth(openBrowser: (url: string) => Promise<void>): Promise<void>;
  isMsGraphAuthenticated(): boolean;
  getMsGraphAccount(): string | null;
  onMsGraphAuthChange(handler: () => void): void;

  // LLM + lifecycle + logging
  callLlm(prompt: string, options?: { maxTokens?: number; systemPrompt?: string }): Promise<string>;
  logEvent(level: "info" | "warn" | "error", message: string, data?: unknown): void;
  onShutdown(handler: () => void | Promise<void>): void;
}

export interface PluginRuntimeContext {
  pluginId: string;
  hostRoot: string;
  pluginRoot: string;
  config?: Record<string, unknown>;
  log: (message: string, meta?: unknown) => void;
  hostApi: PluginHostApi;
}

export type PluginToolHandler = (payload?: unknown) => Promise<unknown> | unknown;
export type PluginMethodHandler = PluginToolHandler;

export interface RuntimePlugin {
  handlers: Record<string, PluginToolHandler>;
  start?: () => void | Promise<void>;
  stop?: () => void | Promise<void>;
}

export type RuntimePluginFactory = (context: PluginRuntimeContext) => Promise<RuntimePlugin> | RuntimePlugin;

export interface PluginCard {
  id: string;
  name: string;
  description: string;
  sampleTools: string[];
}
