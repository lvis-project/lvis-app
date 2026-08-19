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
import { isAppVisible } from "./tool-visibility.js";
import { pathToFileURL } from "node:url";

/**
 * #885 v6 — the app-visible method names a manifest declares: the normalized
 * `Tool[]` whose `_meta.ui.visibility` includes "app". This is the app-visible
 * tool allowlist that feeds the renderer IPC bridge (`assertAppVisibleToolInvokable`) —
 * the {app-only ∪ dual} set.
 */
export function declaredAppVisibleToolMethods(
  manifest: Pick<PluginManifest, "tools">,
): string[] {
  return (manifest.tools ?? []).filter(isAppVisible).map((t) => t.name);
}

/**
 * #885 v6 — every runtime-invokable method name (model / app / dual is now one
 * `Tool` object). De-duped defensively though `parsePluginJson` already rejects
 * duplicate names at load. This is the full declared-tool set (the model-visible
 * ∪ app-visible tool union).
 */
/**
 * Module-private: `buildMethodMap` is the only derivation of the declared
 * runtime methods. Every instantiation path goes through it.
 */
function declaredRuntimeMethods(manifest: Pick<PluginManifest, "tools">,
): string[] {
  return [...new Set((manifest.tools ?? []).map((t) => t.name))];
}

/**
 * Build a file:// import URL from an entry path.
 *
 * It lives HERE rather than in `sandbox.ts` because it is the one line of that
 * module an isolated plugin child needs, and `sandbox.ts` reaches Electron
 * through `plugins/storage.ts` (`safeStorage`). A child is a plain Node process
 * where that import does not resolve, so leaving this function there would have
 * forced the child to either carry a second copy of it or drag Electron in —
 * and it is `import()`'s own argument, so the module that performs the import
 * is where it belongs. Nothing else in `sandbox.ts` used it.
 */
export function buildImportUrl(entryPath: string, bustCache = false): string {
  const url = pathToFileURL(entryPath).href;
  return bustCache ? `${url}?reload=${Date.now()}` : url;
}

/**
 * Dynamically import a plugin's resolved entry path and return its factory
 * (`default` preferred, else `createPlugin`), or `undefined` when neither is
 * exported. Import failures propagate to the caller so each site can log /
 * audit them in its own phase.
 *
 * ELECTRON-FREE, and that is load-bearing: an out-of-process plugin child calls
 * this to obtain the same factory the in-process loader obtains, so the two
 * arms cannot disagree about which export is the plugin.
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
  manifest: Pick<PluginManifest, "tools">,
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
