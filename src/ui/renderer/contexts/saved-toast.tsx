import { createContext, useContext, useEffect, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";

/**
 * Settings-wide "저장되었습니다" notifier — every successful save in the
 * settings dialog (orchestrated tabs through useSettingsOrchestration's
 * onSaved wrapper, and own-IPC tabs like PluginConfigTab/AppearanceTab/
 * RolesTab/McpTab via direct `useNotifySaved()` calls) MUST hit this so
 * the user sees one consistent feedback signal regardless of which tab
 * triggered the write.
 *
 * Lives in its own file (not in SettingsContent) to avoid the circular
 * import that would otherwise form: SettingsContent imports tab components,
 * tab components import the notifier. Keeping the context here lets both
 * sides depend on the same neutral module.
 */
const SavedToastContext = createContext<(() => void) | null>(null);

export const SavedToastProvider = SavedToastContext.Provider;

export function useNotifySaved(): () => void {
  const cb = useContext(SavedToastContext);
  // No-op when no provider is mounted. In dev we surface a warning so a
  // future regression (PluginConfigTab rendered standalone, a debug panel
  // mounting a tab outside the settings dialog) becomes loud immediately
  // instead of silently swallowing every save toast.
  if (cb == null) {
    if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        "[saved-toast] useNotifySaved() called outside <SavedToastProvider>. " +
          "Wrap the consumer in <SavedToastProvider value={notifySaved}> so " +
          "save events surface the dialog-wide toast.",
      );
    }
    return () => {};
  }
  return cb;
}

/**
 * Floating "저장되었습니다" pill rendered at the top-center of the settings
 * dialog over the sidebar + right pane. Anchored to its `relative` parent
 * (NOT to a scroll container) so the pill stays visible no matter how far
 * the user has scrolled within a tab.
 *
 * `at` is treated as a change signal — every new value (re)opens the
 * toast for ~2.4s. Callers should pass a monotonically increasing counter
 * (not `Date.now()`) so back-to-back saves in the same millisecond still
 * re-fire the effect.
 */
export function SavedToastFloating({ at }: { at: number | null }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (at == null) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 2400);
    return () => clearTimeout(timer);
  }, [at]);
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="settings-saved-toast"
      className="pointer-events-none absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-success px-4 py-1.5 text-sm font-medium text-success-foreground shadow-lg ring-1 ring-success/(--opacity-medium) motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-200"
    >
      <span aria-hidden="true">✓</span>
      <span>{t("savedToast.saved")}</span>
    </div>
  );
}
