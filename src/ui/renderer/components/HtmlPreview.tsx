import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import type { RenderHtmlPayload } from "../types.js";

type OpenState = "idle" | "opening" | "opened" | "error";

export function HtmlPreview({
  payload,
  allowScripts = false,
  autoOpen = false,
  autoOpenKey,
}: {
  payload: RenderHtmlPayload;
  allowScripts?: boolean;
  autoOpen?: boolean;
  autoOpenKey?: string;
}) {
  const [openState, setOpenState] = useState<OpenState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const autoOpenedKeyRef = useRef<string | null>(null);

  const openPreviewWindow = useCallback(async () => {
    const api = window.lvisApi.window?.openHtmlPreview;
    if (!api) {
      setOpenState("error");
      setErrorMessage("창 열기 API가 준비되지 않았습니다.");
      return;
    }

    setOpenState("opening");
    setErrorMessage(null);
    const result = await api({
      html: payload.html,
      title: payload.title ?? "HTML 렌더",
      height: Math.max(420, payload.height + 140),
      allowScripts,
      warnings: payload.warnings,
    });
    if (result.ok) {
      setOpenState("opened");
      return;
    }
    setOpenState("error");
    setErrorMessage(result.error);
  }, [allowScripts, payload.height, payload.html, payload.title, payload.warnings]);

  useEffect(() => {
    if (!autoOpen) return;
    const key = autoOpenKey ?? `${payload.title ?? ""}:${payload.height}:${allowScripts}`;
    if (autoOpenedKeyRef.current === key) return;
    autoOpenedKeyRef.current = key;
    void openPreviewWindow();
  }, [allowScripts, autoOpen, autoOpenKey, openPreviewWindow, payload.height, payload.title]);

  return (
    <div className="mt-2 overflow-hidden rounded border bg-background">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{payload.title ?? "HTML 미리보기"}</span>
        <span className="shrink-0 text-[10px] opacity-60">별도 창 · JS {allowScripts ? "허용" : "차단"}</span>
      </div>
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0 text-[11px] text-muted-foreground">
          {openState === "opened" ? "창을 열었습니다." : "HTML 결과를 창에서 표시합니다."}
          {openState === "error" && errorMessage && (
            <span className="ml-2 text-destructive">{errorMessage}</span>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void openPreviewWindow()}
          disabled={openState === "opening"}
        >
          {openState === "opening" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ExternalLink className="h-3.5 w-3.5" />
          )}
          <span>{openState === "opened" ? "다시 열기" : "창 열기"}</span>
        </Button>
      </div>
      {payload.warnings && payload.warnings.length > 0 && (
        <div className="border-t px-2 py-1 text-[10px] text-warning">
          정제됨: {payload.warnings.join(", ")}
        </div>
      )}
    </div>
  );
}
