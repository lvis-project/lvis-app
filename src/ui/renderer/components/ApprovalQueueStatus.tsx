/**
 * ApprovalQueueStatus — renderer UI for approval queue depth.
 *
 * Renders a small floating badge showing the number of pending approval
 * requests plus a compact list of waiting requests (tool name + source).
 * Appears only when the queue has 2+ entries (the head-of-queue is already
 * shown by ToolApprovalDialog; this surfaces what is queued BEHIND it).
 *
 * Order-preserving: items render in the same FIFO order as the underlying
 * queue state, so the "next up" is the first entry shown here (index 1 in
 * the queue; entry 0 is in the modal).
 */
import { Badge } from "../../../components/ui/badge.js";
import { DEFAULT_APPROVAL_QUEUE_MAX } from "../../../lib/approval-queue-reducer.js";
import { SOURCE_BADGE } from "../constants.js";
import type { ApprovalRequest } from "../types.js";
import { trustOriginLabel } from "../utils/trust-origin-label.js";

export interface ApprovalQueueStatusProps {
  queue: ApprovalRequest[];
  max?: number;
}

export function ApprovalQueueStatus({
  queue,
  max = DEFAULT_APPROVAL_QUEUE_MAX,
}: ApprovalQueueStatusProps) {
  if (queue.length < 2) return null;
  // Head-of-queue is shown by the modal; list the rest.
  const waiting = queue.slice(1);
  const isFull = queue.length >= max;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`승인 요청 ${queue.length}개 대기 중`}
      data-testid="approval-queue-status"
      className="fixed bottom-4 right-4 z-40 w-72 rounded-lg border border-border bg-background/95 p-3 shadow-lg backdrop-blur"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">대기 중인 승인</span>
        <Badge
          variant={isFull ? "default" : "secondary"}
          className={isFull ? "bg-destructive text-destructive-foreground" : undefined}
          data-testid="approval-queue-depth"
        >
          {queue.length} / {max}
        </Badge>
      </div>
      {isFull ? (
        <p className="mb-2 text-xs text-destructive">
          승인 큐가 가득 차 새 요청은 거부됩니다.
        </p>
      ) : null}
      <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
        {waiting.map((req) => (
          <li
            key={req.id}
            data-testid="approval-queue-item"
            className="rounded border border-border/50 bg-muted/40 px-2 py-1"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono">{req.toolName}</span>
              <div className="flex shrink-0 gap-1">
                {req.source ? (
                  <Badge variant="outline" className="text-[10px]">
                    {SOURCE_BADGE[req.source] ?? req.source}
                  </Badge>
                ) : null}
                <Badge variant="outline" className="text-[10px]">
                  {trustOriginLabel(req.trustOrigin)}
                </Badge>
              </div>
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
              {req.reason}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
