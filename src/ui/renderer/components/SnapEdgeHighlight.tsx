/**
 * SnapEdgeHighlight — 2px accent border overlay that appears on the main window
 * when a detached child window is dragged into the magnetic snap zone.
 *
 * Listens for `lvis:window:snap-edge` IPC events broadcast by WindowManager
 * and renders a thin highlight on the corresponding edge.
 */

import { useEffect, useState } from "react";

type SnapEdge = "n" | "s" | "e" | "w";

const EDGE_CLASSES: Record<SnapEdge, string> = {
  n: "top-0 left-0 right-0 h-0.5",
  s: "bottom-0 left-0 right-0 h-0.5",
  w: "left-0 top-0 bottom-0 w-0.5",
  e: "right-0 top-0 bottom-0 w-0.5",
};

export function SnapEdgeHighlight() {
  const [activeEdge, setActiveEdge] = useState<SnapEdge | null>(null);

  useEffect(() => {
    const api = window.lvisApi;
    if (!api?.window?.onSnapEdge) return;
    const unsub = api.window.onSnapEdge((edge) => {
      setActiveEdge(edge as SnapEdge | null);
    });
    return unsub;
  }, []);

  if (!activeEdge) return null;

  return (
    <div
      className={`pointer-events-none fixed z-50 bg-primary/(--opacity-intense) transition-opacity ${EDGE_CLASSES[activeEdge]}`}
      aria-hidden="true"
    />
  );
}
