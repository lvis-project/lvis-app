import { createRoot } from "react-dom/client";
import { App } from "./ui/renderer/App.js";
import { DetachedView } from "./ui/renderer/DetachedView.js";
import { primeHostMarketplaceApi } from "./ui/renderer/host-marketplace-api.js";

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

// Guard with `typeof document` so importing <App /> from a jsdom test
// harness (no #root) doesn't double-mount or throw.
if (typeof document !== "undefined") {
  primeHostMarketplaceApi();
  const root = document.getElementById("root");
  if (root) {
    const detachedViewKey = getDetachedViewKey();
    if (detachedViewKey) {
      createRoot(root).render(<DetachedView viewKey={detachedViewKey} />);
    } else {
      createRoot(root).render(<App />);
    }
  }
}
