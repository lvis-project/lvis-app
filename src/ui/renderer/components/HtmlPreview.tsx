import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import {
  RENDER_HTML_THEME_TOKEN_NAMES,
  type RenderHtmlThemeTokens,
} from "../../../shared/render-html-preview.js";
import type { RenderHtmlPayload } from "../types.js";
import { useTranslation } from "../../../i18n/react.js";

type OpenState = "idle" | "opening" | "opened" | "error";

function readRenderHtmlThemeTokens(): RenderHtmlThemeTokens | undefined {
  if (typeof window.getComputedStyle !== "function") return undefined;
  const styles = window.getComputedStyle(document.documentElement);
  const tokens: RenderHtmlThemeTokens = {};
  for (const name of RENDER_HTML_THEME_TOKEN_NAMES) {
    const value = styles.getPropertyValue(`--${name}`).trim();
    if (value) tokens[name] = value;
  }
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

export function HtmlPreview({
  payload,
  allowScripts = false,
  requiresScripts = false,
  autoOpen = false,
  autoOpenKey,
}: {
  payload: RenderHtmlPayload;
  allowScripts?: boolean;
  requiresScripts?: boolean;
  autoOpen?: boolean;
  autoOpenKey?: string;
}) {
  const { t } = useTranslation();
  const [openState, setOpenState] = useState<OpenState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const autoOpenedKeyRef = useRef<string | null>(null);

  const openPreviewWindow = useCallback(async () => {
    const api = window.lvisApi.window?.openHtmlPreview;
    if (!api) {
      setOpenState("error");
      setErrorMessage(t("htmlPreview.apiNotReady"));
      return;
    }

    setOpenState("opening");
    setErrorMessage(null);
    const result = await api({
      html: payload.html,
      title: payload.title ?? t("htmlPreview.defaultTitle"),
      height: Math.max(420, payload.height + 140),
      allowScripts,
      requiresScripts,
      warnings: payload.warnings,
      themeTokens: readRenderHtmlThemeTokens(),
    });
    if (result.ok) {
      setOpenState("opened");
      return;
    }
    setOpenState("error");
    setErrorMessage(result.error);
  }, [allowScripts, payload.height, payload.html, payload.title, payload.warnings, requiresScripts, t]);

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
        <span className="min-w-0 truncate">{payload.title ?? t("htmlPreview.previewTitle")}</span>
        <span className="shrink-0 text-[10px] opacity-60">
          {t("htmlPreview.separateWindow")} · {requiresScripts ? t("htmlPreview.jsWindowSetting") : t("htmlPreview.noJs")}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0 text-[11px] text-muted-foreground">
          {openState === "opened"
            ? t("htmlPreview.windowOpened")
            : requiresScripts
              ? t("htmlPreview.scriptSettingHint")
              : t("htmlPreview.htmlResultHint")}
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
          <span>{openState === "opened" ? t("htmlPreview.reopenButton") : t("htmlPreview.openButton")}</span>
        </Button>
      </div>
      {payload.warnings && payload.warnings.length > 0 && (
        <div className="border-t px-2 py-1 text-[10px] text-warning">
          {t("htmlPreview.sanitizedPrefix")}{payload.warnings.join(", ")}
        </div>
      )}
    </div>
  );
}
