export interface ChatTabProps {
  autoCompact: boolean;
  setAutoCompact: (updater: boolean | ((prev: boolean) => boolean)) => void;
}

export function ChatTab({ autoCompact, setAutoCompact }: ChatTabProps) {
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
    </div>
  );
}
