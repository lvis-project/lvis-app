import { useEffect, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { WEB_PROVIDERS } from "../constants.js";
import type { LvisApi } from "../types.js";
import { getApi } from "../api-client.js";
import { useNotifySaved } from "../contexts/saved-toast.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";
import { useTranslation } from "../../../i18n/react.js";

/* ─── webView preferredFlow options (relocated from AppearanceTab — it is
      browsing behavior, so it belongs on the Web / Browsing tab) ─────────── */
type WebViewPreferredFlow = "in-app" | "system-browser";

const WEBVIEW_OPTIONS: ReadonlyArray<{ value: WebViewPreferredFlow; label: string; hint: string }> = [
  { value: "in-app", label: "appearanceTab.webViewInApp", hint: "appearanceTab.webViewInAppHint" },
  { value: "system-browser", label: "appearanceTab.webViewSystemBrowser", hint: "appearanceTab.webViewSystemBrowserHint" },
];

function useWebViewPreferredFlow(): {
  flow: WebViewPreferredFlow;
  setFlow: (next: WebViewPreferredFlow) => void;
} {
  const [flow, setFlowState] = useState<WebViewPreferredFlow>("in-app");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const api = getApi();
        const settings = await api.getSettings();
        if (cancelled) return;
        const next = settings.webView?.preferredFlow;
        if (next === "in-app" || next === "system-browser") {
          setFlowState(next);
        }
      } catch {
        /* ignore — toggle stays at default until user interacts */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const notifySaved = useNotifySaved();
  const setFlow = (next: WebViewPreferredFlow) => {
    const prev = flow;
    setFlowState(next);
    if (typeof process !== "undefined" && process.env?.LVIS_DEV === "1") {
      // dev-mode toggle log — formal telemetry deferred (see plan §7).
      // eslint-disable-next-line no-console
      console.log(`[settings] webView.preferredFlow changed: ${prev} -> ${next}`);
    }
    try {
      const api = getApi();
      void api
        .updateSettings({ webView: { preferredFlow: next } })
        .then(() => notifySaved())
        .catch(() => { /* ignore — local state already reflects */ });
    } catch {
      /* ignore */
    }
  };

  return { flow, setFlow };
}

export interface WebTabProps {
  api: LvisApi;
  webProvider: string;
  setWebProvider: (v: string) => void;
  hasWebKey: boolean;
  setHasWebKey: (v: boolean) => void;
  webKeyInput: string;
  setWebKeyInput: (v: string) => void;
  onSaved: () => void;
  /** Debounced immediate-apply hook — fired when the user picks a provider. */
  onImmediateChange?: () => void;
}

export function WebTab(props: WebTabProps) {
  const { t } = useTranslation();
  const { api, webProvider, setWebProvider, hasWebKey, setHasWebKey, webKeyInput, setWebKeyInput, onSaved, onImmediateChange } = props;
  const webInfo = WEB_PROVIDERS.find((p) => p.id === webProvider) ?? WEB_PROVIDERS[0];
  const { flow: webViewFlow, setFlow: setWebViewFlow } = useWebViewPreferredFlow();

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={t("webTab.pageTitle")}
        description={t("webTab.pageDescription")}
      />

      <SettingsSection
        title={t("webTab.searchEngineTitle")}
        description={t("webTab.searchEngineDescription")}
        badge={
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("webTab.immediateApplyBadge")}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2">
          {WEB_PROVIDERS.map((p) => (
            <Button key={p.id} size="sm" variant={webProvider === p.id ? "default" : "outline"} className="justify-start text-xs" onClick={() => { setWebProvider(p.id); onImmediateChange?.(); }}>
              {p.label}
            </Button>
          ))}
        </div>
      </SettingsSection>

      {webInfo.needsKey && (
        <SettingsSection
          title={t("webTab.apiKeyTitle", { label: webInfo.label })}
        >
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t("webTab.apiKeyLabel", { label: webInfo.label })}</Label>
            <div className="flex items-center gap-2">
              {hasWebKey ? <Badge variant="default" className="text-xs">{t("webTab.keySet")}</Badge> : <Badge variant="secondary" className="text-xs">{t("webTab.keyNotSet")}</Badge>}
              {hasWebKey && <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => void api.deleteWebApiKey(webProvider).then(() => { setHasWebKey(false); onSaved(); })}>{t("webTab.deleteButton")}</Button>}
            </div>
            <Input type="password" placeholder={hasWebKey ? t("webTab.replaceKeyPlaceholder") : webInfo.placeholder} value={webKeyInput} onChange={(e) => setWebKeyInput(e.target.value)} />
          </div>
        </SettingsSection>
      )}

      {/* ── 외부 URL 표시 정책 (relocated from Appearance — browsing behavior) ── */}
      <SettingsSection
        title={t("appearanceTab.webViewSectionTitle")}
        description={t("appearanceTab.webViewSectionDescription")}
        actions={
          <span className="text-[11px] text-muted-foreground">
            {t("appearanceTab.webViewCurrentLabel")} <span className="font-mono text-foreground">{webViewFlow}</span>
          </span>
        }
      >
        <div
          role="radiogroup"
          aria-label={t("appearanceTab.webViewRadioGroupLabel")}
          data-testid="webview-preferred-flow"
          className="flex flex-wrap gap-2"
        >
          {WEBVIEW_OPTIONS.map((opt) => {
            const checked = webViewFlow === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={checked}
                data-value={opt.value}
                title={t(opt.hint)}
                onClick={() => setWebViewFlow(opt.value)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  checked
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/(--opacity-half) hover:text-foreground"
                }`}
              >
                {t(opt.label)}
              </button>
            );
          })}
        </div>
      </SettingsSection>
    </div>
  );
}
