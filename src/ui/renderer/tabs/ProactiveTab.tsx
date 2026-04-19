export interface ProactiveTabProps {
  enableDailyBriefing: boolean;
  setEnableDailyBriefing: (updater: boolean | ((prev: boolean) => boolean)) => void;
}

export function ProactiveTab({ enableDailyBriefing, setEnableDailyBriefing }: ProactiveTabProps) {
  return (
    <div className="space-y-4 pt-4">
      <div className="space-y-2">
        <div>
          <p className="text-sm font-medium">데일리 브리핑</p>
          <p className="text-[11px] text-muted-foreground">장기간 idle 상태일 때 태스크·일정·메모를 종합한 일일 브리핑을 LLM으로 요약해 알려줍니다. 하루 1회, 사용자가 닫으면 24시간 재표시 안 함.</p>
        </div>
        <div className="flex items-center gap-3 rounded-md border px-3 py-3">
          <button
            type="button"
            role="checkbox"
            aria-checked={enableDailyBriefing}
            aria-labelledby="daily-briefing-toggle-label"
            className={`relative h-5 w-5 flex-shrink-0 rounded border-2 transition-colors ${enableDailyBriefing ? "border-primary bg-primary" : "border-muted-foreground"} cursor-pointer hover:border-primary/60`}
            onClick={() => setEnableDailyBriefing((prev) => !prev)}
          >
            {enableDailyBriefing && (
              <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-primary-foreground">✓</span>
            )}
          </button>
          <div className="space-y-0.5">
            <p id="daily-briefing-toggle-label" className="text-sm font-medium">데일리 브리핑 활성화</p>
            <p className="text-[11px] text-muted-foreground">기본값은 꺼짐입니다. 켜면 idle scan 중 요약이 생성됩니다.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
