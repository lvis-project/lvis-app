import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { VENDORS } from "../constants.js";

export interface FallbackEntry {
  provider: string;
  model: string;
}

export interface AdvancedTabProps {
  temperature: number;
  setTemperature: (v: number) => void;
  maxOutputTokens: number;
  setMaxOutputTokens: (v: number) => void;
  seedInput: string;
  setSeedInput: (v: string) => void;
  responseFormat: "text" | "json";
  setResponseFormat: (v: "text" | "json") => void;
  stopSequencesText: string;
  setStopSequencesText: (v: string) => void;
  streamSmoothing: "none" | "word" | "char";
  setStreamSmoothing: (v: "none" | "word" | "char") => void;
  fallbackChain: FallbackEntry[];
  setFallbackChain: (updater: FallbackEntry[] | ((c: FallbackEntry[]) => FallbackEntry[])) => void;
  fallbackOpen: boolean;
  setFallbackOpen: (updater: boolean | ((o: boolean) => boolean)) => void;
}

export function AdvancedTab(props: AdvancedTabProps) {
  const {
    temperature,
    setTemperature,
    maxOutputTokens,
    setMaxOutputTokens,
    seedInput,
    setSeedInput,
    responseFormat,
    setResponseFormat,
    stopSequencesText,
    setStopSequencesText,
    streamSmoothing,
    setStreamSmoothing,
    fallbackChain,
    setFallbackChain,
    fallbackOpen,
    setFallbackOpen,
  } = props;

  return (
    <div className="space-y-4 pt-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Temperature</label>
          <span className="text-xs tabular-nums text-muted-foreground">{temperature.toFixed(1)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.1}
          value={temperature}
          onChange={(e) => setTemperature(Number(e.target.value))}
          className="w-full accent-primary"
          aria-label="Temperature"
        />
        <p className="text-[11px] text-muted-foreground">0에 가까울수록 결정적, 높을수록 창의적.</p>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Max Output Tokens</label>
          <span className="text-xs tabular-nums text-muted-foreground">{maxOutputTokens.toLocaleString()}</span>
        </div>
        <input
          type="range"
          min={128}
          max={8192}
          step={128}
          value={maxOutputTokens}
          onChange={(e) => setMaxOutputTokens(Number(e.target.value))}
          className="w-full accent-primary"
          aria-label="Max output tokens"
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Seed</label>
        <Input
          type="number"
          value={seedInput}
          onChange={(e) => setSeedInput(e.target.value)}
          placeholder="비워 두면 랜덤"
        />
        <p className="text-[11px] text-muted-foreground">정수 입력 시 벤더가 지원하면 결정론적 샘플링.</p>
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Response Format</label>
        <select
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
          value={responseFormat}
          onChange={(e) => setResponseFormat(e.target.value as "text" | "json")}
        >
          <option value="text">Text</option>
          <option value="json">JSON</option>
        </select>
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Stop Sequences</label>
        <textarea
          className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
          value={stopSequencesText}
          onChange={(e) => setStopSequencesText(e.target.value)}
          placeholder="한 줄에 하나씩"
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Stream Smoothing</label>
        <div className="flex gap-4 text-sm">
          {(["none", "word", "char"] as const).map((opt) => (
            <label key={opt} className="flex items-center gap-1">
              <input
                type="radio"
                name="stream-smoothing"
                value={opt}
                checked={streamSmoothing === opt}
                onChange={() => setStreamSmoothing(opt)}
              />
              {opt === "none" ? "None" : opt === "word" ? "Word" : "Char"}
            </label>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">출력 스트림을 단어/문자 단위로 부드럽게 표시합니다.</p>
      </div>
      <div className="space-y-2 rounded-md border">
        <button
          type="button"
          className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
          onClick={() => setFallbackOpen((o) => !o)}
        >
          <span>장애 복구 (Fallback Chain)</span>
          <span className="text-muted-foreground">{fallbackOpen ? "▲" : "▼"}</span>
        </button>
        {fallbackOpen && (
          <div className="space-y-2 px-3 pb-3">
            <p className="text-[11px] text-muted-foreground">기본 모델이 5xx/429/네트워크 오류를 반환할 때 순서대로 시도할 벤더·모델 목록입니다.</p>
            {fallbackChain.map((entry, idx) => (
              <div key={idx} className="flex gap-2">
                <select
                  className="flex h-8 rounded-md border border-input bg-background px-2 text-xs"
                  value={entry.provider}
                  onChange={(e) => {
                    const next = [...fallbackChain];
                    next[idx] = { ...next[idx]!, provider: e.target.value };
                    setFallbackChain(next);
                  }}
                >
                  {VENDORS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                </select>
                <Input
                  className="h-8 text-xs"
                  value={entry.model}
                  placeholder="모델 이름"
                  onChange={(e) => {
                    const next = [...fallbackChain];
                    next[idx] = { ...next[idx]!, model: e.target.value };
                    setFallbackChain(next);
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs text-destructive"
                  onClick={() => setFallbackChain((c) => c.filter((_, i) => i !== idx))}
                >
                  삭제
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => setFallbackChain((c) => [...c, { provider: "openai", model: "" }])}
            >
              + 추가
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
