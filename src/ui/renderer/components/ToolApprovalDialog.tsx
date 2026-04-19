import { useEffect, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { SOURCE_BADGE } from "../constants.js";
import type { ApprovalChoice, ApprovalRequest } from "../types.js";

export function ToolApprovalDialog({
  open,
  request,
  pendingCount = 1,
  onDecide,
  onDecideAll,
}: {
  open: boolean;
  request: ApprovalRequest | null;
  pendingCount?: number;
  onDecide: (choice: ApprovalChoice, pattern?: string) => void;
  /**
   * D4 §4.5.3 — bulk approve/deny all pending requests at once.
   * Only surfaces when pendingCount > 1 (parallel tool execution).
   */
  onDecideAll?: (choice: "allow-once" | "deny-once") => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // 키보드 단축키
  // D4: Shift+A / Shift+D bulk-decide all pending when there are multiple.
  useEffect(() => {
    if (!open || !request) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "a" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (e.shiftKey && pendingCount > 1 && onDecideAll) {
          onDecideAll("allow-once");
        } else {
          onDecide("allow-once");
        }
      } else if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (e.shiftKey && pendingCount > 1 && onDecideAll) {
          onDecideAll("deny-once");
        } else {
          onDecide("deny-once");
        }
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onDecide("allow-once");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, request, onDecide, onDecideAll, pendingCount]);

  if (!request) return null;

  const title = "도구 승인 필요";
  const argsStr = JSON.stringify(request.args, null, 2) ?? "";
  const argsTruncated = argsStr.length > 500 && !expanded;
  const argsDisplay = argsTruncated ? argsStr.slice(0, 500) + "\n…" : argsStr;
  const sourceBadge = request.source ? SOURCE_BADGE[request.source] ?? request.source : "알 수 없음";
  const hasPending = pendingCount > 1;

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        className="max-w-lg"
        onInteractOutside={(e) => {
          if (request.requireExplicit) {
            e.preventDefault();
          } else {
            void onDecide("deny-once");
          }
        }}
        onEscapeKeyDown={(e) => {
          if (request.requireExplicit) {
            e.preventDefault();
          } else {
            void onDecide("deny-once");
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {title}
            {hasPending && (
              <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                대기 중 {pendingCount - 1}개
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            AI 에이전트가 아래 도구를 실행하려 합니다. 허용하시겠습니까?
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* 도구 이름 + 소스 배지 */}
          <div className="flex items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 text-sm font-mono">
              {request.toolName}
            </code>
            <Badge variant="outline" className="text-[11px]">{sourceBadge}</Badge>
          </div>

          {/* 사유 */}
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">승인 사유</p>
            <p className="text-sm">{request.reason}</p>
          </div>

          {/* 인자 미리보기 */}
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">인자</p>
            <pre className="max-h-40 overflow-auto rounded border bg-muted/50 p-2 text-[11px]">
              {argsDisplay}
            </pre>
            {argsStr.length > 500 && (
              <button
                className="mt-1 text-[11px] text-primary underline"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? "접기" : "모두 보기"}
              </button>
            )}
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            size="sm"
            variant="default"
            onClick={() => onDecide("allow-once")}
            title="단축키: A 또는 Enter"
          >
            한 번만 허용
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onDecide("allow-always", request.toolName)}
          >
            항상 허용
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onDecide("deny-once")}
            title="단축키: D"
          >
            거부
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => onDecide("deny-always", request.toolName)}
          >
            항상 거부
          </Button>

          {/* D4 §4.5.3 — bulk buttons surface only when multiple tools are pending */}
          {hasPending && onDecideAll && (
            <>
              <Button
                size="sm"
                variant="default"
                className="border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
                onClick={() => onDecideAll("allow-once")}
                title={`대기 중인 ${pendingCount}개 도구 모두 허용 (단축키: Shift+A)`}
              >
                모두 허용 ({pendingCount})
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-destructive/40 text-destructive hover:bg-destructive/10"
                onClick={() => onDecideAll("deny-once")}
                title={`대기 중인 ${pendingCount}개 도구 모두 거부 (단축키: Shift+D)`}
              >
                모두 거부 ({pendingCount})
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
