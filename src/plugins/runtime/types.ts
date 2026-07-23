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
import type { HostApiGenerationScope } from "../plugin-host-effect-scope.js";

export type { PluginAccessSpec, PluginManifest, PluginToolHandler, RuntimePlugin };

export type PluginLifecycleHookScope = {
  active: boolean;
  depth: number;
};

/**
 * A fully-loaded plugin: manifest + running instance + registered handlers.
 * #885 v6 — `manifest` is the materialized `PluginManifest` (`parsePluginJson`
 * output); every runtime consumer reads its `tools: Tool[]` via the
 * tool-visibility primitive.
 */
export type LoadedPlugin = {
  activationId: string;
  manifest: PluginManifest;
  pluginRoot: string;
  instance: RuntimePlugin;
  methods: Map<string, PluginToolHandler>;
  approvedPluginAccess?: PluginAccessSpec;
  hostEffects?: HostApiGenerationScope;
  started?: boolean;
  deactivateHostApi?: () => void;
  drainHostApiOperations?: () => Promise<void>;
  lifecycleHookScope?: PluginLifecycleHookScope;
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
