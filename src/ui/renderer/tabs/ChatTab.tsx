export interface ChatTabProps {
  autoCompact: boolean;
  setAutoCompact: (updater: boolean | ((prev: boolean) => boolean)) => void;
  streamSmoothing: "none" | "word" | "char";
  setStreamSmoothing: (v: "none" | "word" | "char") => void;
  experimentalContinuousBackend?: boolean;
  setExperimentalContinuousBackend?: (v: boolean) => void;
}

export function ChatTab({ autoCompact, setAutoCompact, streamSmoothing, setStreamSmoothing, experimentalContinuousBackend, setExperimentalContinuousBackend }: ChatTabProps) {
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
            <p className="text-[11px] text-muted-foreground">기본값 OFF — 설정 후 앱 재시작 없이 전환됩니다.</p>
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
                <p className="text-[11px] text-muted-foreground">타이틀 자동 생성 + 체크포인트 압축을 활성화합니다. 기본값 OFF — 프로덕션에서 검증 중.</p>
              </div>
            </div>
        </div>
      )}
    </div>
  );
}
