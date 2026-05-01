/**
 * Dynamic Lucide icon resolver for the plugin grid.
 *
 * Plugins declare their icon by name in `manifest.icon` (e.g. `"Mic"`).
 * The host looks up that PascalCase name in the lucide-react export map and
 * returns the matching component. Unknown names and absent declarations both
 * fall back to `Plug` — no ICON_MAP hardcoded per plugin id, so adding new
 * plugins never requires a host change.
 */
import * as LucideIcons from "lucide-react";
import type { LucideIcon } from "lucide-react";

const FALLBACK_ICON: LucideIcon = LucideIcons.Plug;

/**
 * Resolve the Lucide icon for a plugin manifest.
 *
 * @param manifest - Object with an optional `icon` field (Lucide name, PascalCase).
 * @returns A `LucideIcon` component — guaranteed non-null. Falls back to `Plug`.
 */
export function pluginIconFor(manifest: { icon?: string }): LucideIcon {
  if (!manifest.icon) return FALLBACK_ICON;
  const candidate = (LucideIcons as Record<string, unknown>)[manifest.icon];
  if (typeof candidate === "function" || (typeof candidate === "object" && candidate !== null)) {
    return candidate as LucideIcon;
  }
  return FALLBACK_ICON;
}
