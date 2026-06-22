import { useCallback } from "react";
import { PrivacyTab } from "./PrivacyTab.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";
import { useTranslation } from "../../../i18n/react.js";

export interface ChatTabProps {
  autoCompact: boolean;
  setAutoCompact: (updater: boolean | ((prev: boolean) => boolean)) => void;
  streamSmoothing: "none" | "word" | "char";
  setStreamSmoothing: (v: "none" | "word" | "char") => void;
  idlePreferenceRefresh?: boolean;
  setIdlePreferenceRefresh?: (v: boolean) => void;
  piiRedactEnabled: boolean;
  onPiiRedactToggle: () => void;
  settingsLoaded: boolean;
  /** Debounced immediate-apply hook for chat settings saved through the chat payload. */
  onImmediateChange?: () => void;
}

export function ChatTab({
  autoCompact,
  setAutoCompact,
  streamSmoothing,
  setStreamSmoothing,
  idlePreferenceRefresh,
  setIdlePreferenceRefresh,
  piiRedactEnabled,
  onPiiRedactToggle,
  settingsLoaded,
  onImmediateChange,
}: ChatTabProps) {
  const { t } = useTranslation();
  // Memoize the wrapped onToggle so PrivacyTab receives a stable identity
  // across re-renders — if PrivacyTab ever memoizes via React.memo / props
  // comparison, an inline arrow would defeat it.
  const handlePiiRedactToggle = useCallback(() => {
    onPiiRedactToggle();
    onImmediateChange?.();
  }, [onPiiRedactToggle, onImmediateChange]);

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={t("chatTab.title")}
        description={t("chatTab.description")}
      />

      <SettingsSection
        title={t("chatTab.conversationOptimizationTitle")}
        description={t("chatTab.conversationOptimizationDescription")}
      >
        <div className="flex items-center gap-3 rounded-md border px-3 py-3">
          <Checkbox
            checked={autoCompact}
            disabled={!settingsLoaded}
            className="size-5"
            onCheckedChange={(checked) => {
              setAutoCompact(checked === true);
              onImmediateChange?.();
            }}
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("chatTab.autoCompactLabel")}</p>
            <p className="text-[11px] text-muted-foreground">{t("chatTab.autoCompactHint")}</p>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("chatTab.streamSmoothingTitle")}
        description={t("chatTab.streamSmoothingDescription")}
      >
        <RadioGroup
          className="flex gap-4 text-sm"
          value={streamSmoothing}
          disabled={!settingsLoaded}
          onValueChange={(value) => {
            setStreamSmoothing(value as "none" | "word" | "char");
            onImmediateChange?.();
          }}
          aria-label="Stream smoothing"
        >
          {(["none", "word", "char"] as const).map((opt) => (
            <Label key={opt} className="flex items-center gap-1">
              <RadioGroupItem value={opt} />
              {opt === "none" ? t("chatTab.streamOptNone") : opt === "word" ? t("chatTab.streamOptWord") : t("chatTab.streamOptChar")}
            </Label>
          ))}
        </RadioGroup>
      </SettingsSection>

      <SettingsSection
        title={t("chatTab.experimentalTitle")}
        description={t("chatTab.experimentalDescription")}
      >
        <div className="flex items-center gap-3 rounded-md border px-3 py-3">
          <Checkbox
            checked={idlePreferenceRefresh ?? true}
            disabled={!settingsLoaded}
            data-testid="idle-preference-refresh-toggle"
            className="size-5"
            onCheckedChange={(checked) => {
              setIdlePreferenceRefresh?.(checked === true);
            }}
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("chatTab.idleRefreshLabel")}</p>
            <p className="text-[11px] text-muted-foreground">
              {t("chatTab.idleRefreshHint")}
            </p>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("chatTab.privacyTitle")}
        description={t("chatTab.privacyDescription")}
      >
        <PrivacyTab
          piiRedactEnabled={piiRedactEnabled}
          onToggle={handlePiiRedactToggle}
        />
      </SettingsSection>
    </div>
  );
}
