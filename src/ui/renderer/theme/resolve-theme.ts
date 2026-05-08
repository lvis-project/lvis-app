import type { ThemeBundle } from "./bundles/index.js";
import type { ResolvedShell } from "./types.js";

/**
 * Apply a ThemeBundle to the document root element.
 *
 * Sets:
 *   - `data-theme-bundle="<id>"` — activates the matching CSS block in styles.css
 *   - `data-shell="<light|dark>"` — drives color-scheme meta for native widgets
 *   - class `lvis-bundle-<id>` — for test selectors / snapshot matching
 *
 * Removes all prior `lvis-bundle-*` classes before adding the new one.
 * Idempotent.
 */
export function applyBundleToDocument(bundle: ThemeBundle, doc: Document = document): void {
  const root = doc.documentElement;
  // Remove all prior bundle classes
  const toRemove = Array.from(root.classList).filter((c) => c.startsWith("lvis-bundle-"));
  root.classList.remove(...toRemove);
  root.setAttribute("data-theme-bundle", bundle.id);
  root.setAttribute("data-shell", bundle.shell);
  root.classList.add(`lvis-bundle-${bundle.id}`);
}

/**
 * For the LGE pair (lge-light / lge-dark): resolve which bundle to use based
 * on `prefers-color-scheme`. Returns "lge-light" for a light OS scheme, "lge-dark"
 * otherwise.
 *
 * Only called when `followSystem` is true and the current bundleId is one of
 * the LGE pair.
 */
export function resolveSystemPair(
  win: Pick<Window, "matchMedia"> | undefined = typeof window !== "undefined" ? window : undefined,
): "lge-light" | "lge-dark" {
  try {
    const mql = win?.matchMedia?.("(prefers-color-scheme: light)");
    if (mql?.matches) return "lge-light";
  } catch {
    /* matchMedia unavailable */
  }
  return "lge-dark";
}

/**
 * Derive the resolved shell ("light" | "dark") from a bundle.
 * Convenience wrapper for components that need the scalar shell value.
 */
export function bundleShell(bundle: ThemeBundle): ResolvedShell {
  return bundle.shell;
}
