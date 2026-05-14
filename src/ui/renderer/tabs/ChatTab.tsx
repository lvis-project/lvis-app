import { PrivacyTab } from "./PrivacyTab.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";

export interface ChatTabProps {
  autoCompact: boolean;
  setAutoCompact: (updater: boolean | ((prev: boolean) => boolean)) => void;
  streamSmoothing: "none" | "word" | "char";
  setStreamSmoothing: (v: "none" | "word" | "char") => void;
  idlePreferenceRefresh?: boolean;
  setIdlePreferenceRefresh?: (v: boolean) => void;
  piiRedactEnabled: boolean;
  onPiiRedactToggle: () => void;
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
}: ChatTabProps) {
  return (
    <div className="space-y-4 pt-4">
      <div className="space-y-2">
        <div>
          <p className="text-sm font-medium">대화 최적화</p>
          <p className="text-[11px] text-muted-foreground">긴 대화에서 이전 히스토리를 자동으로 요약해 컨텍스트를 절약합니다.</p>
        </div>
        <div className="flex items-center gap-3 rounded-md border px-3 py-3">
          <Checkbox
            checked={autoCompact}
            className="size-5"
            onCheckedChange={(checked) => setAutoCompact(checked === true)}
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">자동 컴팩트 활성화</p>
            <p className="text-[11px] text-muted-foreground">끄면 자동 요약은 중단되고, 수동 `/compact`만 사용할 수 있습니다.</p>
          </div>
        </div>
      </div>
      <div className="space-y-2">
        <Label className="text-sm font-medium">스트림 부드럽게 표시 (Stream Smoothing)</Label>
        <RadioGroup
          className="flex gap-4 text-sm"
          value={streamSmoothing}
          onValueChange={(value) => setStreamSmoothing(value as "none" | "word" | "char")}
          aria-label="Stream smoothing"
        >
          {(["none", "word", "char"] as const).map((opt) => (
            <Label key={opt} className="flex items-center gap-1">
              <RadioGroupItem value={opt} />
              {opt === "none" ? "없음" : opt === "word" ? "단어" : "글자"}
            </Label>
          ))}
        </RadioGroup>
        <p className="text-[11px] text-muted-foreground">출력 스트림을 단어 또는 글자 단위로 부드럽게 표시합니다.</p>
      </div>
      <div className="space-y-2">
        <div>
          <p className="text-sm font-medium">실험적 기능</p>
          <p className="text-[11px] text-muted-foreground">기본값 OFF — 설정 즉시 반영됩니다.</p>
        </div>
        <div className="flex items-center gap-3 rounded-md border px-3 py-3">
          <Checkbox
            checked={idlePreferenceRefresh ?? false}
            data-testid="idle-preference-refresh-toggle"
            className="size-5"
            onCheckedChange={(checked) => setIdlePreferenceRefresh?.(checked === true)}
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Experimental: idle 선호도 자동 갱신</p>
            <p className="text-[11px] text-muted-foreground">
              IDLE_SCAN 동안 AGENTS.md, MEMORY.md, memories/*.md를 LLM에 보내 user-preferences.md를 갱신합니다. 기본값은 OFF입니다.
            </p>
          </div>
        </div>
      </div>
      <section className="space-y-3 border-t border-border pt-4">
        <div>
          <p className="text-sm font-medium">프라이버시</p>
          <p className="text-[11px] text-muted-foreground">채팅 전송 전 개인정보 보호 동작을 설정합니다.</p>
        </div>
        <PrivacyTab
          piiRedactEnabled={piiRedactEnabled}
          onToggle={onPiiRedactToggle}
        />
      </section>
    </div>
  );
}
