import { createRoot } from "react-dom/client";
import { App } from "./ui/renderer/App.js";
import { primeHostMarketplaceApi } from "./ui/renderer/host-marketplace-api.js";

export { App } from "./ui/renderer/App.js";

// Guard with `typeof document` so importing <App /> from a jsdom test
// harness (no #root) doesn't double-mount or throw.
if (typeof document !== "undefined") {
  primeHostMarketplaceApi();
  const root = document.getElementById("root");
  if (root) createRoot(root).render(<App />);
}
