import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { WEB_PROVIDERS } from "../constants.js";
import type { LvisApi } from "../types.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";
import { useTranslation } from "../../../i18n/react.js";

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
    </div>
  );
}
