/**
 * Dynamic Lucide icon resolver for the plugin grid.
 *
 * Plugins declare their icon by name in `manifest.icon` (e.g. `"Mic"`).
 * The host lazy-loads the lucide-react module and resolves the icon by name.
 * This avoids a static `import * as LucideIcons` (which adds all 1 000+ icons
 * to the main bundle) by instead loading lucide-react as a single shared chunk
 * via `React.lazy` + dynamic `import()` — esbuild --splitting moves it out of
 * the critical path. Unknown or absent names fall back to `Plug` synchronously.
 *
 * Wrap call-sites in `<Suspense fallback={…}>` for the async path.
 */
import { lazy, type ComponentType } from "react";
import { Plug } from "lucide-react";
import type { LucideProps } from "lucide-react";

export const FALLBACK_ICON: ComponentType<LucideProps> = Plug;

/**
 * Module-level cache so repeated calls with the same icon name return the
 * identical component reference. This prevents React from treating each render
 * as a new component type (which would unmount/remount and re-trigger Suspense).
 */
const iconCache = new Map<string, ComponentType<LucideProps>>();

/**
 * Resolve the Lucide icon for a plugin manifest.
 *
 * Returns a `LucideIcon` component (lazy-loaded for non-fallback paths).
 * Unknown / missing icon names resolve to the synchronous `Plug` fallback.
 * Results are cached by icon name so the same component reference is returned
 * on every call — safe to use inside render without a `useMemo`.
 *
 * @param manifest - Object with an optional `icon` field (Lucide PascalCase name, e.g. `"Mic"`).
 */
export function pluginIconFor(manifest: { icon?: string }): ComponentType<LucideProps> {
  if (!manifest.icon) return FALLBACK_ICON;
  const name = manifest.icon;
  const cached = iconCache.get(name);
  if (cached) return cached;
  // Eviction policy:
  //   • `.then` "invalid name" → DO NOT evict. The cache exists to keep the
  //     same React.lazy reference across renders so PluginGridButton does
  //     not unmount/remount + re-Suspense on every paint. Evicting on a
  //     stable manifest-input failure (icon name simply does not exist in
  //     lucide-react) reintroduces that churn and re-imports lucide-react
  //     for every render until the manifest changes.
  //   • `.catch` reject (chunk-load failure, transient network) → DO evict.
  //     The lazy resolves to a permanently-rejected promise so any cached
  //     reference would render an error boundary forever; the next call
  //     should get a fresh lazy that retries the import.
  const Icon = lazy(() =>
    import("lucide-react")
      .then((mod) => {
        const candidate = (mod as Record<string, unknown>)[name];
        const isValid =
          typeof candidate === "function" ||
          (typeof candidate === "object" &&
            candidate !== null &&
            "render" in (candidate as object));
        if (!isValid) return { default: FALLBACK_ICON };
        return { default: candidate as ComponentType<LucideProps> };
      })
      .catch(() => {
        iconCache.delete(name);
        return { default: FALLBACK_ICON };
      }),
  );
  iconCache.set(name, Icon);
  return Icon;
}
