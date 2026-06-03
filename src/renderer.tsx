import { createRoot } from "react-dom/client";
import { App } from "./ui/renderer/App.js";
import { DetachedView } from "./ui/renderer/DetachedView.js";
import { primeHostMarketplaceApi } from "./ui/renderer/host-marketplace-api.js";
import { I18nSettingsProvider } from "./ui/renderer/contexts/i18n-settings-provider.js";

export { App } from "./ui/renderer/App.js";

/**
 * Detect detached-window mode: the main process loads the index.html with a
 * URL fragment `#detached/<viewKey>` for child windows spawned by WindowManager.
 */
function getDetachedViewKey(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash; // e.g. "#detached/tasks"
  const match = hash.match(/^#detached\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function getSettingsInitialTab(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash; // e.g. "#settings/llm"
  const match = hash.match(/^#settings\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Guard with `typeof document` so importing <App /> from a jsdom test
// harness (no #root) doesn't double-mount or throw.
if (typeof document !== "undefined") {
  primeHostMarketplaceApi();
  const root = document.getElementById("root");
  if (root) {
    const detachedViewKey = getDetachedViewKey();
    const settingsInitialTab = getSettingsInitialTab();
    if (settingsInitialTab) {
      const appRoot = createRoot(root);
      void import("./ui/renderer/SettingsWindow.js").then(({ SettingsWindow }) => {
        appRoot.render(
          <I18nSettingsProvider>
            <SettingsWindow initialTab={settingsInitialTab} />
          </I18nSettingsProvider>,
        );
      });
    } else if (detachedViewKey) {
      createRoot(root).render(
        <I18nSettingsProvider>
          <DetachedView viewKey={detachedViewKey} />
        </I18nSettingsProvider>,
      );
    } else {
      createRoot(root).render(
        <I18nSettingsProvider>
          <App />
        </I18nSettingsProvider>,
      );
    }
  }
}
