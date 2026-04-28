import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Wrench } from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { parseRenderHtmlResult } from "../utils/html-preview.js";
import { getToolDisplayName } from "../utils/tool-display.js";
import type { RenderHtmlPayload } from "../types.js";
import { HtmlPreview } from "./HtmlPreview.js";
import { McpAppView } from "./McpAppView.js";

/** Single-tool inline indicator — no collapsible wrapper */
function SingleToolInline({ tool }: { tool: Extract<ChatEntry, { kind: "tool_group" }>["tools"][number] }) {
  const [open, setOpen] = useState(false);
  const isRunning = tool.status === "running";
  const isError = tool.status === "error";
  return (
    <div className="max-w-[85%] rounded-md text-xs text-muted-foreground">
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-muted/30"
        onClick={() => setOpen((o) => !o)}
      >
        <Wrench className="h-3 w-3 flex-shrink-0" />
        <span className="font-medium">{getToolDisplayName(tool.name)}</span>
        {isRunning ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Badge variant={isError ? "secondary" : "default"} className={`px-1 py-0 text-[10px] ${isError ? "text-red-400" : ""}`}>
            {isError ? "실패" : "완료"}
          </Badge>
        )}
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
      </button>
      {open && (
        <div className="border-t px-3 py-1.5 font-mono text-[10px] space-y-1">
          {tool.input && (
            <div>
              <div className="mb-0.5 text-[9px] uppercase opacity-60">입력</div>
              <pre className="whitespace-pre-wrap break-all opacity-80">{JSON.stringify(tool.input, null, 2)}</pre>
            </div>
          )}
          {tool.result !== undefined && (
            <div>
              <div className={`mb-0.5 text-[9px] uppercase opacity-60 ${isError ? "text-red-400" : ""}`}>{isError ? "오류" : "결과"}</div>
              <pre className={`whitespace-pre-wrap break-all opacity-80 ${isError ? "text-red-400" : ""}`}>{tool.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolGroupCard({ group }: { group: Extract<ChatEntry, { kind: "tool_group" }> }) {
  // All hooks must be declared before any conditional return (Rules of Hooks)
  const [open, setOpen] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [scriptAllowed, setScriptAllowed] = useState<Set<string>>(new Set());

  // Single tool: render inline without group wrapper
  if (group.tools.length === 1 && group.tools[0]) {
    return <SingleToolInline tool={group.tools[0]} />;
  }
  const doneCount = group.tools.filter((t) => t.status !== "running").length;
  const hasError = group.tools.some((t) => t.status === "error");
  const groupStatus = group.status === "running"
    ? "running"
    : hasError ? "error" : "done";
  const groupTitle = groupStatus === "running" ? "도구 사용 중" : "도구 사용 결과";
  const uniqueToolNames = [...new Set(group.tools.map((t) => getToolDisplayName(t.name)))].join(" · ");

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

  // MCP Apps §3.2 — collect tools that carry a uiPayload
  const mcpAppPreviews = tools.filter(
    (t) => t.status === "done" && t.uiPayload != null,
  );

  function previewNeedsJavaScript(payload: RenderHtmlPayload): boolean {
    return /<script\b|on[a-z]+\s*=|javascript:/i.test(payload.html);
  }

  return (
    <div className="max-w-[85%] rounded-md text-xs text-muted-foreground">
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-muted/30"
        onClick={() => setOpen((o) => !o)}
      >
        <Wrench className="h-3 w-3 flex-shrink-0" />
        <span className="font-medium">{groupTitle}</span>
        <span className="text-[10px] opacity-60 truncate max-w-[200px]">{uniqueToolNames}</span>
        <Badge variant="outline" className="px-1 py-0 text-[10px] flex-shrink-0">
          {groupStatus === "running" ? `${doneCount}/${group.tools.length}` : `${group.tools.length}개`}
        </Badge>
        {groupStatus === "running" ? (
          <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
        ) : (
          <Badge
            variant={groupStatus === "error" ? "secondary" : "default"}
            className={`px-1 py-0 text-[10px] flex-shrink-0 ${groupStatus === "error" ? "text-red-400" : ""}`}
          >
            {groupStatus === "error" ? "오류 있음" : "완료"}
          </Badge>
        )}
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
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
                  <span>{getToolDisplayName(tool.name)}</span>
                  {tool.status === "running" ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <Badge
                      variant={tool.status === "error" ? "secondary" : "default"}
                      className={`px-1 py-0 text-[10px] ${tool.status === "error" ? "text-red-400" : ""}`}
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
            <div key={p.toolUseId} className="space-y-2">
              {previewNeedsJavaScript(p.payload) && (
                <div className="flex items-center justify-between gap-3 rounded border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
                  <span>이 HTML은 JavaScript가 필요할 수 있습니다. 실행을 허용할까요?</span>
                  <Button
                    type="button"
                    size="sm"
                    variant={scriptAllowed.has(p.toolUseId) ? "secondary" : "outline"}
                    onClick={() => {
                      setScriptAllowed((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.toolUseId)) next.delete(p.toolUseId);
                        else next.add(p.toolUseId);
                        return next;
                      });
                    }}
                  >
                    {scriptAllowed.has(p.toolUseId) ? "JavaScript 차단" : "JavaScript 허용"}
                  </Button>
                </div>
              )}
              <HtmlPreview
                payload={p.payload}
                allowScripts={scriptAllowed.has(p.toolUseId)}
              />
            </div>
          ))}
        </div>
      )}
      {mcpAppPreviews.length > 0 && (
        <div className="border-t px-3 py-2 space-y-2">
          {mcpAppPreviews.map((t) => (
            t.uiPayload && <McpAppView key={t.toolUseId} payload={t.uiPayload} />
          ))}
        </div>
      )}
    </div>
  );
}
