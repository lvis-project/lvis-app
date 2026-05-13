import { PrivacyTab } from "./PrivacyTab.js";

export interface ChatTabProps {
  autoCompact: boolean;
  setAutoCompact: (updater: boolean | ((prev: boolean) => boolean)) => void;
  streamSmoothing: "none" | "word" | "char";
  setStreamSmoothing: (v: "none" | "word" | "char") => void;
  experimentalContinuousBackend?: boolean;
  setExperimentalContinuousBackend?: (v: boolean) => void;
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
  experimentalContinuousBackend,
  setExperimentalContinuousBackend,
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
          <button
            type="button"
            role="checkbox"
            aria-checked={autoCompact}
            className={`relative h-5 w-5 flex-shrink-0 rounded border-2 transition-colors ${autoCompact ? "border-primary bg-primary" : "border-muted-foreground"} cursor-pointer hover:border-primary/60`}
            onClick={() => setAutoCompact((prev) => !prev)}
          >
            {autoCompact && (
              <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-primary-foreground">✓</span>
            )}
          </button>
          <div className="space-y-0.5">
            <p className="text-sm font-medium">자동 컴팩트 활성화</p>
            <p className="text-[11px] text-muted-foreground">끄면 자동 요약은 중단되고, 수동 `/compact`만 사용할 수 있습니다.</p>
          </div>
        </div>
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">스트림 부드럽게 표시 (Stream Smoothing)</label>
        <div className="flex gap-4 text-sm" role="radiogroup" aria-label="Stream smoothing">
          {(["none", "word", "char"] as const).map((opt) => (
            <label key={opt} className="flex items-center gap-1">
              <input
                type="radio"
                name="stream-smoothing"
                value={opt}
                checked={streamSmoothing === opt}
                onChange={() => setStreamSmoothing(opt)}
              />
              {opt === "none" ? "없음" : opt === "word" ? "단어" : "글자"}
            </label>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">출력 스트림을 단어 또는 글자 단위로 부드럽게 표시합니다.</p>
      </div>
      {setExperimentalContinuousBackend !== undefined && (
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">실험적 기능</p>
            <p className="text-[11px] text-muted-foreground">
              기본값 OFF — 설정 후 앱 재시작 없이 전환됩니다. 자동 압축은 위 설정에서 제어됩니다.
            </p>
          </div>
          <div className="flex items-center gap-3 rounded-md border px-3 py-3">
              <button
                type="button"
                role="checkbox"
                aria-checked={experimentalContinuousBackend ?? false}
                data-testid="continuous-backend-toggle"
                className={`relative h-5 w-5 flex-shrink-0 rounded border-2 transition-colors ${experimentalContinuousBackend ? "border-primary bg-primary" : "border-muted-foreground"} cursor-pointer hover:border-primary/60`}
                onClick={() => setExperimentalContinuousBackend(!(experimentalContinuousBackend ?? false))}
              >
                {experimentalContinuousBackend && (
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-primary-foreground">✓</span>
                )}
              </button>
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Experimental: 연속 백엔드 (continuous backend)</p>
                <p className="text-[11px] text-muted-foreground">
                  세션 제목 자동 갱신, 연속성 가드, 요약 프리앰블을 활성화합니다. 체크포인트 압축은 자동 컴팩트 설정을 따릅니다.
                </p>
              </div>
          </div>
          {setIdlePreferenceRefresh !== undefined && (
            <div className="flex items-center gap-3 rounded-md border px-3 py-3">
              <button
                type="button"
                role="checkbox"
                aria-checked={idlePreferenceRefresh ?? false}
                data-testid="idle-preference-refresh-toggle"
                className={`relative h-5 w-5 flex-shrink-0 rounded border-2 transition-colors ${idlePreferenceRefresh ? "border-primary bg-primary" : "border-muted-foreground"} cursor-pointer hover:border-primary/60`}
                onClick={() => setIdlePreferenceRefresh(!(idlePreferenceRefresh ?? false))}
              >
                {idlePreferenceRefresh && (
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-primary-foreground">✓</span>
                )}
              </button>
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Experimental: idle 선호도 자동 갱신</p>
                <p className="text-[11px] text-muted-foreground">
                  IDLE_SCAN 동안 AGENTS.md, MEMORY.md, memories/*.md를 LLM에 보내 user-preferences.md를 갱신합니다. 기본값은 OFF입니다.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
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
