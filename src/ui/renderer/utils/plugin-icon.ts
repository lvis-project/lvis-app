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
 * Resolve the Lucide icon for a plugin manifest.
 *
 * Returns either a `React.lazy` component (for a non-empty `icon` field) or
 * the `Plug` fallback directly. The lazy path resolves to `Plug` when the
 * named icon is not found in the lucide-react namespace.
 *
 * @param manifest - Object with an optional `icon` field (Lucide PascalCase name, e.g. `"Mic"`).
 */
export function pluginIconFor(manifest: { icon?: string }): ComponentType<LucideProps> {
  if (!manifest.icon) return FALLBACK_ICON;
  const name = manifest.icon;
  return lazy(() =>
    import("lucide-react").then((mod) => {
      const candidate = (mod as Record<string, unknown>)[name];
      if (typeof candidate === "function" || (typeof candidate === "object" && candidate !== null && "render" in (candidate as object))) {
        return { default: candidate as ComponentType<LucideProps> };
      }
      return { default: FALLBACK_ICON };
    }),
  );
}
