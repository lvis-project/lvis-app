/**
 * Pure translation core — locale-agnostic lookup + interpolation.
 *
 * Kept free of any global/runtime state so it is trivially testable and safe
 * to call from any process. The stateful, ergonomic wrappers (`t`, current
 * locale) live in {@link ./runtime}.
 */
import type { Locale } from "./locale.js";
import { messages, type Messages } from "./messages/index.js";

/** Values that can be interpolated into a message placeholder. */
export type TranslationVars = Record<string, string | number>;

/**
 * Replace `{name}` placeholders in `template` with values from `vars`.
 *
 * Unmatched placeholders are left intact (so a missing var is visible in dev
 * rather than silently blanked). `{{` / `}}` are not special — placeholders
 * are single-brace and must match `[a-zA-Z0-9_]+`.
 */
export function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Resolve `key` for `locale` with a deterministic fallback chain:
 *   active locale → {@link DEFAULT_LOCALE} (English) → the raw key.
 *
 * Returning the key itself on a total miss keeps the UI debuggable (the
 * missing key is visible) instead of rendering an empty string.
 */
export function translate(locale: Locale, key: string, vars?: TranslationVars): string {
  const active: Messages | undefined = messages[locale];
  const fallback: Messages = messages.en;
  const template = active?.[key] ?? fallback[key] ?? key;
  return interpolate(template, vars);
}
