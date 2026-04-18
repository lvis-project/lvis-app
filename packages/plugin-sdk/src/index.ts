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
  toolSchemas?: Record<string, {
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
  startupTools?: string[];
  startupTimeoutMs?: number;
  eventSubscriptions?: string[];
  keywords?: Array<{ keyword: string; skillId: string }>;
  capabilities?: string[];
  ui?: PluginUiExtension[];
  config?: Record<string, unknown>;
  deployment?: DeploymentMode;
  publisher?: string;
}

export interface PluginUiExtension {
  id: string;
  slot: "sidebar" | "toolbar" | "chat-widget";
  entry: string;
  title?: string;
}

export interface PluginHostApi {
  registerKeywords(keywords: Array<{ keyword: string; skillId: string }>): void;
  emitEvent(type: string, payload?: unknown): void;
  onEvent(type: string, handler: (payload: unknown) => void): void;
  addTask(task: { title: string; body?: string; priority?: "low" | "normal" | "high" }): void;
  saveNote(note: { id: string; title: string; body: string; tags?: string[] }): void;
  getSecret(key: string): string | null;
  getMsGraphToken(): Promise<string | null>;
  startMsGraphAuth(openBrowser: (url: string) => Promise<void>): Promise<void>;
  isMsGraphAuthenticated(): boolean;
  getMsGraphAccount(): { email: string; name: string } | null;
  onMsGraphAuthChange(handler: () => void): void;
  logEvent(level: "info" | "warn" | "error", message: string, data?: unknown): void;
  onShutdown(handler: () => void | Promise<void>): void;
}

export interface PluginRuntimeContext {
  pluginId: string;
  hostRoot: string;
  pluginRoot: string;
  config?: Record<string, unknown>;
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
