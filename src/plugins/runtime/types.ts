/**
 * Internal types for the plugin runtime domain modules.
 * These are implementation details — consumers should use the public
 * exports from runtime.ts (PluginRuntime, PluginCard, etc.).
 */

import type {
  PluginAccessSpec,
  PluginManifest,
  PluginToolHandler,
  RuntimePlugin,
} from "../types.js";

export type { PluginAccessSpec, PluginManifest, PluginToolHandler, RuntimePlugin };

/**
 * A fully-loaded plugin: manifest + running instance + registered handlers.
 */
export type LoadedPlugin = {
  manifest: PluginManifest;
  pluginRoot: string;
  instance: RuntimePlugin;
  methods: Map<string, PluginToolHandler>;
  approvedPluginAccess?: PluginAccessSpec;
  started?: boolean;
};

/**
 * Plan entry computed by resolveManifestLoadPlan. Represents one plugin that
 * should be loaded (or skipped when enabled=false).
 */
export type ManifestLoadPlan = {
  pluginIdHint?: string;
  manifestPath: string;
  enabled: boolean;
  approvedPluginAccess?: PluginAccessSpec;
};

/**
 * Per-plugin manifest snapshot including resolved access grants.
 */
export type ManifestSnapshot = {
  manifest: PluginManifest;
  approvedPluginAccess?: PluginAccessSpec;
};

/**
 * Outcome of a single-plugin instantiation + start attempt. Internal to the
 * runtime domain — not part of the public runtime export surface.
 */
export type SinglePluginStartResult = "started" | "deferred" | "failed" | "cancelled";
