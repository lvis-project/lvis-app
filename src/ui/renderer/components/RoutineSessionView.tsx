/**
 * RoutineSessionView — read-only viewer for a single routine session.
 *
 * Renders JSONL lines from a routine session file as a simple timeline.
 * Deliberately does NOT reuse ChatView — routine sessions are read-only
 * history, not interactive chat windows.
 *
 * Q9 isolation: reads only from ~/.lvis/routine/sessions/ via the
 * lvis:routines:v2:read-session IPC (path traversal guard enforced main-side).
 */
import { useEffect, useState } from "react";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import type { LvisApi } from "../types.js";

export interface RoutineSessionViewProps {
  /** Path to the JSONL file (returned by list-sessions IPC). */
  jsonlPath: string;
  api: LvisApi;
  onClose?: () => void;
}

interface SessionLine {
  role?: string;
  content?: unknown;
  text?: string;
  timestamp?: string;
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === "string") return part;
      if (part !== null && typeof part === "object" && (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string") {
        return (part as Record<string, unknown>).text as string;
      }
      return "";
    }).join("\n");
  }
  if (content !== null && content !== undefined) return JSON.stringify(content);
  return "";
}

function parseSessionLine(raw: string): SessionLine | null {
  try {
    return JSON.parse(raw) as SessionLine;
  } catch {
    return null;
  }
}

export function RoutineSessionView({ jsonlPath, api, onClose }: RoutineSessionViewProps) {
  const [lines, setLines] = useState<SessionLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const raw = await api.readRoutineSessionV2(jsonlPath);
        if (cancelled) return;
        const parsed = raw
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map(parseSessionLine)
          .filter((l): l is SessionLine => l !== null);
        setLines(parsed);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [jsonlPath, api]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-card text-card-foreground" data-testid="routine-session-view">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
        <span className="min-w-0 text-sm font-medium text-muted-foreground">루틴 세션 기록</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-muted-foreground hover:text-foreground"
            aria-label="닫기"
          >
            닫기
          </button>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1 px-4 py-3">
        {loading && (
          <p className="text-sm text-muted-foreground py-4 text-center">로딩 중...</p>
        )}
        {error && (
          <p className="text-sm text-destructive py-4 text-center">{error}</p>
        )}
        {!loading && !error && lines.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">기록 없음</p>
        )}
        {!loading && !error && lines.map((line, i) => {
          const role = line.role ?? "unknown";
          const text = line.content !== undefined ? normalizeContent(line.content) : (line.text ?? "");
          const ts = line.timestamp;
          return (
            <div
              key={i}
              className={`mb-3 min-w-0 overflow-hidden rounded-lg px-3 py-2 text-sm ${
                role === "user"
                  ? "bg-muted sm:ml-8"
                  : role === "assistant"
                    ? "bg-primary/10 sm:mr-8"
                    : "bg-secondary/50"
              }`}
              data-testid={`routine-session-line-${role}`}
            >
              <div className="mb-1 flex min-w-0 items-center gap-2">
                <span className="text-xs font-semibold uppercase text-muted-foreground">
                  {role}
                </span>
                {ts && (() => {
                  const d = new Date(ts);
                  const timeStr = isNaN(d.getTime()) ? "" : d.toLocaleTimeString("ko-KR");
                  return timeStr ? (
                    <span className="text-xs text-muted-foreground">{timeStr}</span>
                  ) : null;
                })()}
              </div>
              <SessionLineContent role={role} text={text} />
            </div>
          );
        })}
      </ScrollArea>
    </div>
  );
}

function SessionLineContent({ role, text }: { role: string; text: string }) {
  if (role === "tool_result") {
    return (
      <pre
        className="max-h-72 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-background/70 p-2 font-mono text-xs leading-relaxed"
        data-testid="routine-session-tool-result"
      >
        {text}
      </pre>
    );
  }
  return (
    <p
      className="min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]"
      data-testid="routine-session-text"
    >
      {text}
    </p>
  );
}
