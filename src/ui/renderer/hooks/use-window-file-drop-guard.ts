import { useEffect } from "react";

/**
 * Block the browser default of navigating the renderer window to a dropped
 * `file://` URL. The file drag-drop *indexing* feature was removed (it never
 * had a host scan protocol — the IPC handler always returned an error), so this
 * is the only remaining drag-drop surface: a pure guard that backs up the
 * main-process `will-navigate` deny-by-default policy.
 */
export function useWindowFileDropGuard(): void {
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);
}
