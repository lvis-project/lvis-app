import { createContext, useContext, useEffect, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";




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
