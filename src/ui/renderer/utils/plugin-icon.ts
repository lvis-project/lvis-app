/**
 * Dynamic plugin avatar resolver for the plugin grid.
 *
 * Plugins choose one of two rendering paths via the manifest:
 *   • `iconText`  — short text (1-4 chars) rendered inside the avatar circle
 *                   (e.g. `"EP"`, `"MTG"`). Takes precedence over `icon`.
 *                   Useful when no Lucide glyph matches the plugin's domain
 *                   identity. Rendered synchronously — no Suspense needed.
 *   • `icon`      — Lucide PascalCase name (e.g. `"Mic"`). Host lazy-loads
 *                   the lucide-react module and resolves the icon by name.
 *                   Avoids a static `import * as LucideIcons` (which would
 *                   add all 1 000+ icons to the main bundle) by loading
 *                   lucide-react as a single shared chunk via `React.lazy`
 *                   + dynamic `import()` — esbuild --splitting moves it out
 *                   of the critical path. Unknown / absent names fall back
 *                   to `Plug` synchronously.
 *
 * Wrap call-sites in `<Suspense fallback={…}>` for the async Lucide path.
 */
import { createElement, lazy, type ComponentType } from "react";
import { Plug } from "lucide-react";
import type { LucideProps } from "lucide-react";

export const FALLBACK_ICON: ComponentType<LucideProps> = Plug;

/**
 * Module-level caches so repeated calls with the same input return the
 * identical component reference. This prevents React from treating each
 * render as a new component type (which would unmount/remount and re-trigger
 * Suspense for the Lucide path). Separate maps avoid key collisions between
 * a Lucide name (e.g. `"Box"`) and an iconText value that happens to match.
 */
const lucideIconCache = new Map<string, ComponentType<LucideProps>>();
const textIconCache = new Map<string, ComponentType<LucideProps>>();

/**
 * Per-length font-size, in rem. Tuned so 1-2 chars render at roughly the
 * same visual weight as the Lucide stroke icon (h-7 w-7 ~ 28 px), and 3-4
 * chars shrink to fit inside the same avatar circle without clipping.
 */
const TEXT_FONT_SIZE_REM: Readonly<Record<1 | 2 | 3 | 4, number>> = {
  1: 1.1,
  2: 0.95,
  3: 0.7,
  4: 0.6,
};

function buildTextIcon(rawText: string): ComponentType<LucideProps> {
  // Defense-in-depth: hard-truncate at entry so a manifest that somehow
  // bypasses the SDK schema's `maxLength: 4` (e.g. legacy install path,
  // dev-mode validator skip) still can't blow up the avatar layout or
  // seed an unbounded cache key.
  const text = rawText.slice(0, 4);
  const cached = textIconCache.get(text);
  if (cached) return cached;
  const len = (text.length || 1) as 1 | 2 | 3 | 4;
  const fontSize = `${TEXT_FONT_SIZE_REM[len]}rem`;
  function TextIcon({ className, style }: LucideProps) {
    const callerFontSize = style?.fontSize;
    return createElement(
      "span",
      {
        // `overflow-hidden` clamps the glyph to the box the call-site sizes via
        // `className` (e.g. the 28px plugin-grid avatar, or a 14px picker-row
        // slot). Without it a text glyph tuned for the avatar would spill out
        // of a smaller slot and collide with the adjacent label (the "EPEP"
        // overlap in the slash picker).
        className: `${className ?? ""} inline-flex items-center justify-center overflow-hidden font-bold leading-none tracking-normal`.trim(),
        // Screen readers should announce the badge text — e.g. "EP" — since
        // it carries the plugin's identity. The visual label below the
        // avatar may be the same or richer; double-announce is acceptable.
        "aria-label": text,
        role: "img",
        // Default font-size is tuned for the 28px avatar. Only fontSize is
        // accepted from callers so manifest-controlled icon text cannot gain a
        // broader style injection path through this host component.
        style: { fontSize: callerFontSize ?? fontSize },
      },
      text,
    );
  }
  TextIcon.displayName = `PluginTextIcon(${text})`;
  textIconCache.set(text, TextIcon);
  return TextIcon;
}

/**
 * Resolve the avatar component for a plugin manifest.
 *
 * Precedence: `iconText` > `icon` > `FALLBACK_ICON` (Plug). Results are
 * cached so the same component reference is returned on every call — safe
 * to use inside render without a `useMemo`.
 *
 * @param manifest - Object with optional `iconText` (1-4 char short text) or
 *                   `icon` (Lucide PascalCase name) fields.
 */
export function pluginIconFor(
  manifest: { icon?: string; iconText?: string },
): ComponentType<LucideProps> {
  if (manifest.iconText) return buildTextIcon(manifest.iconText);
  if (!manifest.icon) return FALLBACK_ICON;
  const name = manifest.icon;
  const cached = lucideIconCache.get(name);
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
        lucideIconCache.delete(name);
        return { default: FALLBACK_ICON };
      }),
  );
  lucideIconCache.set(name, Icon);
  return Icon;
}
