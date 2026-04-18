import { createRoot } from "react-dom/client";
import { App } from "./ui/renderer/App.js";

// Phase 1 tests import `BriefingCard` from this module; preserve the export.
export { BriefingCard } from "./ui/renderer/components/BriefingCard.js";
export { App } from "./ui/renderer/App.js";

// Guard with `typeof document` so importing <App /> from a jsdom test
// harness (no #root) doesn't double-mount or throw.
if (typeof document !== "undefined") {
  const root = document.getElementById("root");
  if (root) createRoot(root).render(<App />);
}
