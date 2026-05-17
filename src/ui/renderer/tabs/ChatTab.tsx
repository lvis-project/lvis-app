import { useCallback } from "react";
import { PrivacyTab } from "./PrivacyTab.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";

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
        title="채팅"
        description="자동 컴팩트, 스트리밍 표시, 실험적 기능을 설정합니다"
      />

      <SettingsSection
        title="대화 최적화"
        description="긴 대화에서 이전 히스토리를 자동으로 요약해 컨텍스트를 절약합니다."
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
            <p className="text-sm font-medium">자동 컴팩트 활성화</p>
            <p className="text-[11px] text-muted-foreground">끄면 자동 요약은 중단되고, 수동 `/compact`만 사용할 수 있습니다.</p>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="스트림 부드럽게 표시 (Stream Smoothing)"
        description="출력 스트림을 단어 또는 글자 단위로 부드럽게 표시합니다."
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
              {opt === "none" ? "없음" : opt === "word" ? "단어" : "글자"}
            </Label>
          ))}
        </RadioGroup>
      </SettingsSection>

      <SettingsSection
        title="실험적 기능"
        description="기본값 OFF — 설정 즉시 반영됩니다."
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
            <p className="text-sm font-medium">Experimental: idle 선호도 자동 갱신</p>
            <p className="text-[11px] text-muted-foreground">
              IDLE_SCAN 동안 AGENTS.md, MEMORY.md, memories/*.md를 LLM에 보내 user-preferences.md를 갱신합니다. 기본값은 OFF입니다.
            </p>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="프라이버시"
        description="채팅 전송 전 개인정보 보호 동작을 설정합니다."
      >
        <PrivacyTab
          piiRedactEnabled={piiRedactEnabled}
          onToggle={handlePiiRedactToggle}
        />
      </SettingsSection>
    </div>
  );
}
