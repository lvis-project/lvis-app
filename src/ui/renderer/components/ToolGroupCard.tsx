import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Wrench } from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { parseRenderHtmlResult } from "../utils/html-preview.js";
import type { RenderHtmlPayload } from "../types.js";
import { HtmlPreview } from "./HtmlPreview.js";

export function ToolGroupCard({ group }: { group: Extract<ChatEntry, { kind: "tool_group" }> }) {
  const [open, setOpen] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const doneCount = group.tools.filter((t) => t.status !== "running").length;
  const hasError = group.tools.some((t) => t.status === "error");
  const groupStatus = group.status === "running"
    ? "running"
    : hasError ? "error" : "done";
  const groupTitle = groupStatus === "running" ? "도구 사용 중" : "도구 사용 결과";

  function toggleTool(id: string) {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const tools = [...group.tools].sort((a, b) => a.displayOrder - b.displayOrder);
  const htmlPreviews = tools
    .filter((t) => t.name === "render_html" && t.status === "done")
    .map((t) => ({ toolUseId: t.toolUseId, payload: parseRenderHtmlResult(t.result) }))
    .filter((p): p is { toolUseId: string; payload: RenderHtmlPayload } => p.payload !== null);

  return (
    <div className="max-w-[85%] rounded-md border border-dashed text-xs text-muted-foreground">
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-muted/30"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        <Wrench className="h-3 w-3 flex-shrink-0" />
        <span className="font-medium">{groupTitle}</span>
        <Badge variant="outline" className="px-1 py-0 text-[10px]">
          {groupStatus === "running" ? `${doneCount}/${group.tools.length}` : `${group.tools.length}개`}
        </Badge>
        {groupStatus === "running" ? (
          <Loader2 className="ml-auto h-3 w-3 animate-spin" />
        ) : (
          <Badge
            variant={groupStatus === "error" ? "secondary" : "default"}
            className={`ml-auto px-1 py-0 text-[10px] ${groupStatus === "error" ? "text-red-400" : ""}`}
          >
            {groupStatus === "error" ? "오류 있음" : "완료"}
          </Badge>
        )}
      </button>
      {open && (
        <div className="space-y-1 border-t px-3 py-1.5">
          {tools.map((tool) => {
            const isExpanded = expandedTools.has(tool.toolUseId);
            return (
              <div key={tool.toolUseId} className="rounded border border-dashed/50">
                <button
                  className="flex w-full items-center gap-2 px-2 py-1 hover:bg-muted/20"
                  onClick={() => toggleTool(tool.toolUseId)}
                >
                  {isExpanded ? <ChevronDown className="h-2.5 w-2.5 flex-shrink-0" /> : <ChevronRight className="h-2.5 w-2.5 flex-shrink-0" />}
                  <span className="font-mono">{tool.name}</span>
                  {tool.status === "running" ? (
                    <Loader2 className="ml-auto h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <Badge
                      variant={tool.status === "error" ? "secondary" : "default"}
                      className={`ml-auto px-1 py-0 text-[10px] ${tool.status === "error" ? "text-red-400" : ""}`}
                    >
                      {tool.status === "error" ? "실패" : "완료"}
                    </Badge>
                  )}
                </button>
                {isExpanded && (
                  <div className="space-y-1 border-t px-2 py-1 font-mono text-[10px]">
                    {tool.input && (
                      <div>
                        <div className="mb-0.5 text-[9px] uppercase opacity-60">입력</div>
                        <pre className="whitespace-pre-wrap break-all opacity-80">{JSON.stringify(tool.input, null, 2)}</pre>
                      </div>
                    )}
                    {tool.result !== undefined && (
                      <div>
                        <div className={`mb-0.5 text-[9px] uppercase opacity-60 ${tool.status === "error" ? "text-red-400" : ""}`}>
                          {tool.status === "error" ? "오류" : "결과"}
                        </div>
                        <pre className={`whitespace-pre-wrap break-all opacity-80 ${tool.status === "error" ? "text-red-400" : ""}`}>{tool.result}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {htmlPreviews.length > 0 && (
        <div className="border-t px-3 py-2">
          {htmlPreviews.map((p) => (
            <HtmlPreview key={p.toolUseId} payload={p.payload} allowScripts={true} />
          ))}
        </div>
      )}
    </div>
  );
}
