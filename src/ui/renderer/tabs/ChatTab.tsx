import { useCallback } from "react";
import { PrivacyTab } from "./PrivacyTab.js";
import { Badge } from "../../../components/ui/badge.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import {
  SUBAGENT_MAX_ROUNDS_DEFAULT,
  SUBAGENT_MAX_ROUNDS_MAX,
  SUBAGENT_MAX_ROUNDS_MIN,
} from "../../../shared/subagent-rounds.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";
import { useTranslation } from "../../../i18n/react.js";

import type { MemoryCaptureMode } from "../types.js";

const MEMORY_CAPTURE_MODE_OPTIONS: readonly {
  value: MemoryCaptureMode;
  labelKey: string;
  hintKey: string;
}[] = [
  {
    value: "off",
    labelKey: "chatTab.memoryCaptureOffLabel",
    hintKey: "chatTab.memoryCaptureOffHint",
  },
  {
    value: "review",
    labelKey: "chatTab.memoryCaptureReviewLabel",
    hintKey: "chatTab.memoryCaptureReviewHint",
  },
  {
    value: "auto",
    labelKey: "chatTab.memoryCaptureAutoLabel",
    hintKey: "chatTab.memoryCaptureAutoHint",
  },
];

export interface ChatTabProps {
  autoCompact: boolean;
  setAutoCompact: (updater: boolean | ((prev: boolean) => boolean)) => void;
  streamSmoothing: "none" | "word" | "char";
  setStreamSmoothing: (v: "none" | "word" | "char") => void;
  idlePreferenceRefresh?: boolean;
  setIdlePreferenceRefresh?: (v: boolean) => void;
  idleMemoryConsolidation?: boolean;
  setIdleMemoryConsolidation?: (v: boolean) => void;
  memoryCaptureMode?: MemoryCaptureMode;
  setMemoryCaptureMode?: (v: MemoryCaptureMode) => void;
  subAgentAutonomousWake?: boolean;
  subAgentMaxRounds?: number;
  setSubAgentMaxRounds?: (next: number) => void;
  setSubAgentAutonomousWake?: (v: boolean) => void;
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
  idleMemoryConsolidation,
  setIdleMemoryConsolidation,
  memoryCaptureMode,
  setMemoryCaptureMode,
  subAgentAutonomousWake,
  subAgentMaxRounds,
  setSubAgentMaxRounds,
  setSubAgentAutonomousWake,
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
          aria-label={t("chatTab.streamSmoothingTitle")}
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
        badge={
          <Badge variant="outline" className="text-[10px] uppercase">
            {t("chatTab.experimentalBadge")}
          </Badge>
        }
      >
        <div className="flex items-center gap-3 rounded-md border px-3 py-3">
          <Checkbox
            checked={idlePreferenceRefresh ?? false}
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
        <div className="mt-3 flex items-center gap-3 rounded-md border px-3 py-3">
          <Checkbox
            checked={idleMemoryConsolidation ?? false}
            disabled={!settingsLoaded}
            data-testid="idle-memory-consolidation-toggle"
            className="size-5"
            onCheckedChange={(checked) => {
              setIdleMemoryConsolidation?.(checked === true);
            }}
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("chatTab.idleMemoryConsolidationLabel")}</p>
            <p className="text-[11px] text-muted-foreground">
              {t("chatTab.idleMemoryConsolidationHint")}
            </p>
          </div>
        </div>
        <div className="mt-3 rounded-md border px-3 py-3" data-testid="memory-capture-mode">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("chatTab.memoryCaptureTitle")}</p>
            <p className="text-[11px] text-muted-foreground">
              {t("chatTab.memoryCaptureHint")}
            </p>
          </div>
          <RadioGroup
            className="mt-3 grid gap-2"
            value={memoryCaptureMode ?? "off"}
            disabled={!settingsLoaded}
            onValueChange={(value) => {
              if (value === "off" || value === "review" || value === "auto") {
                setMemoryCaptureMode?.(value);
              }
            }}
            aria-label={t("chatTab.memoryCaptureTitle")}
          >
            {MEMORY_CAPTURE_MODE_OPTIONS.map((option) => (
              <Label
                key={option.value}
                className="flex items-start gap-2 rounded-md border px-3 py-2.5"
              >
                <RadioGroupItem value={option.value} className="mt-0.5" />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">{t(option.labelKey)}</span>
                  <span className="block text-[11px] font-normal text-muted-foreground">
                    {t(option.hintKey)}
                  </span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        </div>
        <div className="mt-3 flex items-center gap-3 rounded-md border px-3 py-3">
          <Checkbox
            checked={subAgentAutonomousWake ?? false}
            disabled={!settingsLoaded}
            data-testid="subagent-autonomous-wake-toggle"
            className="size-5"
            onCheckedChange={(checked) => {
              setSubAgentAutonomousWake?.(checked === true);
            }}
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("chatTab.subAgentWakeLabel")}</p>
            <p className="text-[11px] text-muted-foreground">
              {t("chatTab.subAgentWakeHint")}
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3 rounded-md border px-3 py-3">
          <Input
            type="number"
            min={SUBAGENT_MAX_ROUNDS_MIN}
            max={SUBAGENT_MAX_ROUNDS_MAX}
            // Commit on blur, not per keystroke: typing "12" passes through
            // "1", and a per-keystroke write would persist that and clamp it
            // back into the field mid-edit. `key` remounts the field when the
            // stored value changes, so a clamped value is reflected back.
            key={subAgentMaxRounds ?? SUBAGENT_MAX_ROUNDS_DEFAULT}
            defaultValue={subAgentMaxRounds ?? SUBAGENT_MAX_ROUNDS_DEFAULT}
            disabled={!settingsLoaded}
            data-testid="subagent-max-rounds-input"
            className="w-20"
            onBlur={(e) => {
              const parsed = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(parsed)) setSubAgentMaxRounds?.(parsed);
            }}
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("chatTab.subAgentMaxRoundsLabel")}</p>
            <p className="text-[11px] text-muted-foreground">
              {t("chatTab.subAgentMaxRoundsHint")}
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
