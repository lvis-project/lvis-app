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
  NormalizedManifest,
  PluginToolHandler,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import { isAppVisible } from "./tool-visibility.js";
import { buildImportUrl } from "./sandbox.js";

/**
 * #885 v6 — the UI-invokable method names a manifest declares: the normalized
 * `Tool[]` whose `_meta.ui.visibility` includes "app" (replaces the old
 * `uiActions` keys). Set-equivalent to today's {UI-only ∪ dual} allowlist that
 * feeds the renderer IPC bridge (`assertUiActionInvokable`).
 */
export function declaredUiInvokableMethods(
  manifest: Pick<NormalizedManifest, "tools">,
): string[] {
  return (manifest.tools ?? []).filter(isAppVisible).map((t) => t.name);
}

/**
 * #885 v6 — every runtime-invokable method name (model / app / dual is now one
 * `Tool` object). De-duped defensively though `parsePluginJson` already rejects
 * duplicate names at load. Set-equivalent to today's `tools[] ∪ uiActions`.
 */
export function declaredRuntimeMethods(manifest: Pick<NormalizedManifest, "tools">): string[] {
  return [...new Set((manifest.tools ?? []).map((t) => t.name))];
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
  manifest: Pick<NormalizedManifest, "tools">,
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
