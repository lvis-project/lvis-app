export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  methods: string[];
  config?: Record<string, unknown>;
  ui?: PluginUiExtension[];
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

export interface PluginRegistryEntry {
  id: string;
  manifestPath: string;
  enabled?: boolean;
}

export interface PluginRegistry {
  version: number;
  plugins: PluginRegistryEntry[];
}

export interface PluginMarketplaceItem {
  id: string;
  name: string;
  description: string;
  packageSpec: string;
  packageName: string;
  methods: string[];
  defaultConfig?: Record<string, unknown>;
  ui?: PluginUiExtension[];
}

export interface PluginRuntimeContext {
  pluginId: string;
  pluginRoot: string;
  hostRoot: string;
  config?: Record<string, unknown>;
  log: (message: string, meta?: unknown) => void;
}

export type PluginMethodHandler = (payload?: unknown) => Promise<unknown> | unknown;

export interface RuntimePlugin {
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
  handlers: Record<string, PluginMethodHandler>;
}

export type RuntimePluginFactory = (context: PluginRuntimeContext) => Promise<RuntimePlugin> | RuntimePlugin;

