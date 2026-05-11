/**
 * RoutineSessionView — read-only viewer for a single routine session.
 *
 * Renders JSONL messages from a routine session file as a read-only
 * conversation timeline.
 * Deliberately does NOT reuse ChatView — routine sessions are read-only
 * history, not interactive chat windows — but assistant/tool_result rendering
 * follows the same components used by the main conversation loop.
 *
 * Q9 isolation: reads only from ~/.lvis/routine/sessions/ via the
 * lvis:routines:v2:read-session IPC (path traversal guard enforced main-side).
 */
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import type { ChatEntry, ToolEntryItem } from "../../../lib/chat-stream-state.js";
import type { LvisApi } from "../types.js";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";
import { AssistantCard } from "./AssistantCard.js";
import { ToolGroupCard } from "./ToolGroupCard.js";
import { WorkGroup } from "./WorkGroup.js";

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
  thought?: string;
  toolUseId?: string;
  toolName?: string;
  isError?: boolean;
  meta?: unknown;
  toolCalls?: Array<{
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
}

type RoutineSessionEntry =
  | Extract<ChatEntry, { kind: "assistant" }>
  | Extract<ChatEntry, { kind: "user" }>
  | Extract<ChatEntry, { kind: "tool_group" }>;

interface RoutineSessionModel {
  userEntries: Array<Extract<ChatEntry, { kind: "user" }>>;
  summary: string | null;
  workEntries: Array<
    Extract<ChatEntry, { kind: "assistant" }>
    | Extract<ChatEntry, { kind: "tool_group" }>
  >;
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

function toRoutineSessionModel(lines: SessionLine[]): RoutineSessionModel {
  const userEntries: RoutineSessionModel["userEntries"] = [];
  const workEntries: RoutineSessionModel["workEntries"] = [];
  const pendingToolInputs = new Map<string, { name: string; input?: Record<string, unknown> }>();
  let pendingTools: ToolEntryItem[] = [];
  let pendingGroupIndex = 0;
  let summary: string | null = null;
  let sawAssistantText = false;

  const flushTools = () => {
    if (pendingTools.length === 0) return;
    const groupId = `routine-tools-${pendingGroupIndex}`;
    workEntries.push({
      kind: "tool_group",
      groupId,
      groupIds: [groupId],
      status: pendingTools.some((tool) => tool.status === "error") ? "error" : "done",
      tools: pendingTools,
    });
    pendingTools = [];
    pendingGroupIndex += 1;
  };

  lines.forEach((line, index) => {
    const role = line.role ?? "unknown";
    if (role === "assistant") {
      flushTools();
      for (const toolCall of line.toolCalls ?? []) {
        if (!toolCall.id || !toolCall.name) continue;
        pendingToolInputs.set(toolCall.id, { name: toolCall.name, input: toolCall.input });
      }
      const rawText = normalizeContent(line.content ?? line.text ?? "");
      const extractedSummary = extractSummaryText(rawText);
      if (extractedSummary) summary = extractedSummary;
      const text = cleanAssistantText(rawText);
      if (text.trim().length > 0) {
        sawAssistantText = true;
        workEntries.push({ kind: "assistant", text, streaming: false, phase: "work" });
      }
      return;
    }

    if (role === "tool_result") {
      const toolUseId = line.toolUseId ?? `routine-tool-${index}`;
      const previousToolCall = pendingToolInputs.get(toolUseId);
      pendingTools.push({
        toolUseId,
        name: line.toolName ?? previousToolCall?.name ?? "tool",
        displayOrder: pendingTools.length,
        status: line.isError ? "error" : "done",
        input: previousToolCall?.input,
        result: normalizeContent(line.content ?? line.text ?? ""),
      });
      return;
    }

    flushTools();
    if (role === "user") {
      const text = normalizeContent(line.content ?? line.text ?? "");
      if (text.trim().length > 0) {
        userEntries.push({ kind: "user", text });
      }
    }
  });

  flushTools();
  return {
    userEntries,
    summary: summary ?? (sawAssistantText ? "[요약 형식 누락]" : null),
    workEntries,
  };
}

function cleanAssistantText(text: string): string {
  return text.replace(/\n?\s*<summary>[\s\S]*?<\/summary>\s*$/i, "").trim();
}

function extractSummaryText(text: string): string | null {
  const match = text.match(/<summary>([\s\S]*?)<\/summary>\s*$/i);
  const summary = match?.[1]?.trim();
  return summary && summary.length > 0 ? summary : null;
}

export function RoutineSessionView({ jsonlPath, api, onClose }: RoutineSessionViewProps) {
  const [model, setModel] = useState<RoutineSessionModel>({
    userEntries: [],
    summary: null,
    workEntries: [],
  });
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
        setModel(toRoutineSessionModel(parsed));
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
        {!loading && !error && model.userEntries.length === 0 && !model.summary && model.workEntries.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">기록 없음</p>
        )}
        {!loading && !error && (
          <RoutineSessionTimeline model={model} />
        )}
      </ScrollArea>
    </div>
  );
}

function RoutineSessionTimeline({ model }: { model: RoutineSessionModel }) {
  return (
    <div className="min-w-0 space-y-3">
      {model.userEntries.map((entry, i) => (
        <RoutineSessionEntryCard key={`user-${i}`} entry={entry} />
      ))}
      {model.summary && (
        <RoutineResultSummary summary={model.summary} />
      )}
      {model.workEntries.length > 0 && (
        <div className="min-w-0 rounded-lg bg-secondary/30 px-2 py-1" data-testid="routine-session-workgroup">
          <WorkGroup stepCount={model.workEntries.length} streaming={false}>
            {model.workEntries.map((entry, i) => (
              <RoutineSessionEntryCard key={`work-${i}`} entry={entry} />
            ))}
          </WorkGroup>
        </div>
      )}
    </div>
  );
}

function RoutineResultSummary({ summary }: { summary: string }) {
  return (
    <section
      className="min-w-0 rounded-lg bg-primary/10 px-3 py-3 text-sm"
      data-testid="routine-session-summary"
    >
      <div className="prose prose-sm lvis-prose max-w-none break-words [overflow-wrap:anywhere]">
        <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
          {summary}
        </ReactMarkdown>
      </div>
    </section>
  );
}

function RoutineSessionEntryCard({ entry }: { entry: RoutineSessionEntry }) {
  if (entry.kind === "assistant") {
    return (
      <div className="min-w-0 overflow-hidden rounded-lg bg-muted/30 px-1 py-1" data-testid="routine-session-line-assistant">
        <AssistantCard entry={entry} isFinal={false} />
      </div>
    );
  }

  if (entry.kind === "tool_group") {
    return (
      <div className="min-w-0 overflow-hidden rounded-lg bg-muted/30 px-2 py-1" data-testid="routine-session-line-tool_result">
        <ToolGroupCard group={entry} />
      </div>
    );
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-lg bg-muted px-3 py-2 text-sm" data-testid="routine-session-line-user">
      <p className="min-w-0 whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]" data-testid="routine-session-text">
        {entry.text}
      </p>
    </div>
  );
}
