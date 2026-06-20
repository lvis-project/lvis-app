import { useMemo } from "react";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { formatToolPayloadValue } from "../utils/tool-payload-format.js";

/** Pretty, bounded code block for tool input/output. */
export function ToolPayloadBlock({ value, isError = false }: { value: unknown; isError?: boolean }) {
  const formatted = useMemo(() => formatToolPayloadValue(value), [value]);
  const scrollable = shouldConstrainPayload(formatted);
  const pre = (
    <pre
      className={`max-w-full whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[10px] leading-[1.35rem] [overflow-wrap:anywhere] ${
        isError ? "text-destructive" : "text-muted-foreground"
      }`}
      data-testid="tool-payload"
    >
      {formatted}
    </pre>
  );
  return (
    <div className="min-w-0 max-w-full rounded bg-muted/(--opacity-stronger) ring-1 ring-border/(--opacity-half)">
      {scrollable ? <ScrollArea className="h-[6.9rem]">{pre}</ScrollArea> : pre}
    </div>
  );
}

function shouldConstrainPayload(value: string): boolean {
  const lines = value.split("\n");
  if (lines.length > 5) return true;
  // Long JSON/XML/RSS strings often wrap visually into many rows without
  // containing newline characters. Approximate wrapped rows so every tool
  // input/output follows the same "about 5 visible lines" rule.
  const estimatedVisualLines = lines.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(line.length / 96)),
    0,
  );
  return estimatedVisualLines > 5;
}
