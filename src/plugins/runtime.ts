/**
 * Backward-compat re-export shim.
 * Real implementation lives in runtime/.
 *
 * All existing importers of `./runtime.js` or `../plugins/runtime.js` continue
 * to work without modification — this shim re-exports every public symbol.
 */

// resolvePluginEntryPath is used by unit tests and internal entry-path guards.
export {
  createNoopHostApiForTests,
  resolvePluginEntryPath,
} from "./runtime/sandbox.js";

// Main class + interfaces
export {
  PluginRuntime,
} from "./runtime/index.js";

export type {
  PluginCard,
  PluginPerfStats,
  PluginPreparationProgressInput,
  PluginPreparationStatus,
  PluginToolInvocationContext,
  PluginToolInvocationDelegate,
  PluginRuntimeOptions,
} from "./runtime/index.js";

export type {
  ManifestLoadPlan,
  ManifestSnapshot,
} from "./runtime/types.js";
