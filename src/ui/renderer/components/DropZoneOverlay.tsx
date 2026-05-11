/**
 * D7 — DropZoneOverlay
 *
 * Full-window translucent overlay that appears when the user drags files over
 * the Electron window. On drop, extracts absolute paths via
 * window.lvisApi.fileScanPaths() (preload bridge → IPC → plugin
 * document-indexer capability) and shows a brief toast result.
 *
 * Design constraints:
 * - Uses dragenter/dragleave/dragover/drop on the window — NOT on an inner
 *   element — so it does not intercept normal text-selection drags (those
 *   do not set dataTransfer.files).
 * - overlay is only shown when dataTransfer contains files (type check on
 *   dragover via dataTransfer.types includes "Files").
 * - Cleans up all listeners on unmount.
 */
import { useCallback, useEffect, useRef, useState } from "react";

interface DropZoneOverlayProps {
  /** Called with result for parent-level toast/notification; optional. */
  onResult?: (result: { ok: boolean; indexed?: number; failed?: number; error?: string }) => void;
}

export function DropZoneOverlay({ onResult }: DropZoneOverlayProps) {
  const [visible, setVisible] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // dragenter/dragleave fire on every child element transition — use a counter
  // to track real "inside window" state.
  const dragCountRef = useRef(0);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      dragCountRef.current += 1;
      setVisible(true);
    };

    const onDragLeave = () => {
      dragCountRef.current = Math.max(0, dragCountRef.current - 1);
      if (dragCountRef.current === 0) setVisible(false);
    };

    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };

    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      dragCountRef.current = 0;
      setVisible(false);

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      // Electron webUtils.getPathForFile — exposed via preload as window.lvisApi
      // The preload does NOT expose webUtils directly; paths are resolved IPC-side
      // using Electron's webUtils.getPathForFile. Here in the renderer we pass
      // the File objects' names as a fallback for dev; in production Electron
      // provides real paths via the IPC handler (using webContents.getPathForFile).
      // However, the idiomatic Electron approach is to use webUtils in the
      // renderer context (exposed via preload) or rely on the IPC bridge.
      // We use window.lvisApi.fileScanPaths which accepts paths.
      // Electron 28+ exposes webUtils in renderer via contextBridge — but since
      // our preload doesn't expose it yet, we use the File.path property that
      // Electron makes available on File objects in the renderer.
      const paths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        // In Electron renderer, File objects have a non-standard `.path` property
        // with the absolute path. This is the correct Electron API for renderer-side
        // path extraction (distinct from webUtils.getPathForFile which is main-process).
        const p = (f as File & { path?: string }).path;
        if (p) paths.push(p);
      }

      if (paths.length === 0) {
        showToast("파일 경로를 읽을 수 없습니다.");
        return;
      }

      try {
        const result = await (window as Window & { lvisApi?: { fileScanPaths?: (p: string[]) => Promise<{ ok: boolean; indexed?: number; failed?: number; error?: string }> } }).lvisApi?.fileScanPaths?.(paths);
        if (!result) {
          showToast("인덱서 응답 없음");
          return;
        }
        onResult?.(result);
        if (result.ok) {
          const indexed = result.indexed ?? 0;
          const failed = result.failed ?? 0;
          showToast(
            failed > 0
              ? `${indexed}개 인덱싱 완료, ${failed}개 실패`
              : `${indexed}개 파일 인덱싱 완료`,
          );
        } else {
          showToast(result.error === "no-indexer" ? "인덱서 플러그인을 찾을 수 없습니다" : `오류: ${result.error ?? "unknown"}`);
        }
      } catch (err) {
        showToast(`인덱싱 오류: ${(err as Error).message}`);
      }
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);

    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [onResult, showToast]);

  return (
    <>
      {visible && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            backgroundColor: "rgba(59, 130, 246, 0.15)",
            border: "2px dashed rgba(59, 130, 246, 0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              background: "hsl(var(--popover) / 0.92)",
              color: "hsl(var(--popover-foreground))",
              borderRadius: 12,
              padding: "16px 32px",
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: "0.01em",
            }}
          >
            파일을 드롭하여 인덱싱
          </div>
        </div>
      )}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10000,
            background: "hsl(var(--popover) / 0.95)",
            color: "hsl(var(--popover-foreground))",
            borderRadius: 8,
            padding: "10px 24px",
            fontSize: 14,
            pointerEvents: "none",
          }}
        >
          {toast}
        </div>
      )}
    </>
  );
}
