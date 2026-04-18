import { createElement, useEffect, useMemo, useRef } from "react";
import type { RenderHtmlPayload } from "../types.js";

export function HtmlPreview({ payload }: { payload: RenderHtmlPayload }) {
  const webviewRef = useRef<HTMLElement | null>(null);
  const dataUrl = useMemo(
    () => `data:text/html;charset=utf-8,${encodeURIComponent(payload.html)}`,
    [payload.html],
  );

  // <webview> isn't part of React's intrinsic element table; attach
  // Electron-specific attributes imperatively so we don't need a global JSX
  // declaration. The element itself is a plain lowercase tag that React
  // happily renders into the DOM — Electron picks it up at attach time.
  useEffect(() => {
    const el = webviewRef.current;
    if (!el) return;
    el.setAttribute("partition", "lvis-render-html");
    el.setAttribute("allowpopups", "false");
    el.setAttribute(
      "webpreferences",
      "contextIsolation=yes, sandbox=yes, nodeIntegration=no, javascript=yes",
    );
    el.setAttribute("disablewebsecurity", "false");
  }, []);

  return (
    <div className="mt-2 overflow-hidden rounded border bg-background">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
        <span className="truncate">{payload.title ?? "HTML 미리보기"}</span>
        <span className="text-[10px] opacity-60">격리된 프로세스 · 샌드박스</span>
      </div>
      {createElement("webview", {
        ref: webviewRef,
        src: dataUrl,
        style: {
          width: "100%",
          height: `${payload.height}px`,
          border: 0,
          display: "flex",
          background: "transparent",
        },
      })}
      {payload.warnings && payload.warnings.length > 0 && (
        <div className="border-t px-2 py-1 text-[10px] text-amber-500">
          정제됨: {payload.warnings.join(", ")}
        </div>
      )}
    </div>
  );
}
