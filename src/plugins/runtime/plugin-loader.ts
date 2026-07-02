/**
 * Plugin module-loading pure slices.
 *
 * These helpers consolidate the two structural patterns that every
 * instantiation path (load / addPlugin / restartPlugin / reloadPlugin) shares:
 *   - `importPluginFactory` — dynamic-import the entry module and pick the
 *     `default` / `createPlugin` export.
 *   - `buildMethodMap` — collect declared tool handlers off an instance,
 *     skipping (and reporting) missing handlers.
 *
 * They are intentionally free of runtime state and side effects beyond the
 * import itself so each call site keeps its own error handling / audit /
 * logging exactly as before.
 */
import type {
  PluginManifest,
  PluginToolHandler,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import { buildImportUrl } from "./sandbox.js";

/**
 * The UI-invokable method names a manifest declares — the keys of
 * `manifest.uiActions`. These are the only methods reachable from the renderer
 * IPC bridge (SDK 5.20.0 migrated off the legacy `uiCallable[]` allowlist).
 */
export function declaredUiInvokableMethods(
  manifest: Pick<PluginManifest, "uiActions">,
): string[] {
  return manifest.uiActions ? Object.keys(manifest.uiActions) : [];
}

/**
 * The set of runtime method names a manifest declares — the union of `tools`
 * and `uiActions`, de-duplicated while preserving first-seen order.
 */
export function declaredRuntimeMethods(manifest: PluginManifest): string[] {
  return [...new Set([...(manifest.tools ?? []), ...declaredUiInvokableMethods(manifest)])];
}

/**
 * Dynamically import a plugin's resolved entry path and return its factory
 * (`default` preferred, else `createPlugin`), or `undefined` when neither is
 * exported. Import failures propagate to the caller so each site can log /
 * audit them in its own phase.
 */
export async function importPluginFactory(
  resolvedEntryPath: string,
  bustCache?: boolean,
): Promise<RuntimePluginFactory | undefined> {
  const module = (await import(buildImportUrl(resolvedEntryPath, bustCache))) as {
    default?: RuntimePluginFactory;
    createPlugin?: RuntimePluginFactory;
  };
  return module.default ?? module.createPlugin;
}

/**
 * Build the `toolName → handler` map for a plugin instance from its declared
 * runtime methods. Methods without a matching handler are skipped and passed
 * to `onMissingHandler` so the caller can emit its site-specific warning.
 */
export function buildMethodMap(
  manifest: PluginManifest,
  instance: RuntimePlugin,
  onMissingHandler: (toolName: string) => void,
): Map<string, PluginToolHandler> {
  const methods = new Map<string, PluginToolHandler>();
  for (const toolName of declaredRuntimeMethods(manifest)) {
    const handler = instance.handlers[toolName];
    if (!handler) {
      onMissingHandler(toolName);
      continue;
    }
    methods.set(toolName, handler);
  }
  return methods;
}
