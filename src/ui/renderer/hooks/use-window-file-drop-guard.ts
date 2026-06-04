import { useEffect } from "react";

/**
 * Block the browser default of navigating the renderer window to a dropped
 * `file://` URL.
 *
 * This is the *primary* protection against file-drop navigation, not a backup:
 * the main-process `will-navigate` guard (`main.ts`) deliberately allows
 * `file://` (the app itself loads `index.html` over `file://`), so it does NOT
 * stop a dropped file from replacing the renderer. The drag-drop *indexing*
 * feature that used to own this guard (`DropZoneOverlay`) was removed — it never
 * had a host scan protocol — leaving this hook as the sole drag-drop surface.
 *
 * A drag is treated as a file drag when `dataTransfer.types` includes `"Files"`
 * OR `dataTransfer.files` is non-empty. The `files` fallback covers platforms
 * where the OS/Electron populates the file list without the `"Files"` type
 * (notably on `drop`, where `files` is the authoritative source). Non-file drags
 * (text selection, in-app DnD) are left untouched so they keep working.
 */
export function useWindowFileDropGuard(): void {
  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => {
      const dt = e.dataTransfer;
      if (!dt) return false;
      return dt.types.includes("Files") || dt.files.length > 0;
    };
    const block = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);
}
