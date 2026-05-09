/**
 * Q12 Phase 2.5 — out-of-allowed-dir approval card.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 1.
 *
 * Renderer routes here when `ApprovalRequest.kind === "out-of-allowed-dir"`.
 * UX rules (security review M3 strengthening):
 *
 *   1. Three-button choice — "한 번만 허용" / "디렉토리 영구 추가" / "거부".
 *   2. "디렉토리 영구 추가" requires re-typed confirmation (phishing
 *      defense): user must re-type the suggested-parent directory name
 *      before the persist button is enabled.
 *   3. Adjacency warnings rendered as a red banner with explicit opt-in.
 *   4. Auto-suggest leaf-parent only — never the broadest common-prefix.
 *
 * Layered IPC: this component does NOT directly write settings. The
 * "디렉토리 영구 추가" choice is surfaced as
 * `choice: "allow-always" + rememberPattern: <suggestedParent>` so the
 * existing approval-respond pipeline carries the persist intent
 * back to main, where the slash dispatcher rules run (Phase 5 will fully
 * wire — Phase 2.5 includes the data model only).
 */
import { useEffect, useState } from "react";
import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../components/ui/dialog.js";
import { Input } from "../../../../components/ui/input.js";
import type { ApprovalChoice, ApprovalRequest } from "../../types.js";

interface OutOfAllowedDirCardProps {
  open: boolean;
  request: ApprovalRequest | null;
  onDecide: (choice: ApprovalChoice, rememberPattern?: string) => void;
}

/**
 * Q12 P2.5 — derive the basename for the re-typed confirmation prompt.
 * If `suggestedParent` is null we fall back to the candidate path's
 * basename so the user still has a deterministic name to confirm.
 */
function deriveConfirmName(req: ApprovalRequest): string {
  const target = req.outOfAllowedDir?.suggestedParent
    ?? req.outOfAllowedDir?.candidatePath
    ?? "";
  const segments = target.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? target;
}

export function OutOfAllowedDirCard({
  open,
  request,
  onDecide,
}: OutOfAllowedDirCardProps) {
  const [retypeValue, setRetypeValue] = useState("");
  const [acknowledgedAdjacency, setAcknowledgedAdjacency] = useState(false);

  // Reset confirmation state whenever a new request arrives.
  useEffect(() => {
    if (request) {
      setRetypeValue("");
      setAcknowledgedAdjacency(false);
    }
  }, [request?.id]);

  if (!request || !request.outOfAllowedDir) return null;

  const { candidatePath, suggestedParent, currentAllowed, adjacencyWarnings } =
    request.outOfAllowedDir;
  const confirmName = deriveConfirmName(request);
  const retypeOk = retypeValue.trim() === confirmName;
  const adjacencyBlocking =
    adjacencyWarnings.length > 0 && !acknowledgedAdjacency;
  const persistEnabled = retypeOk && !adjacencyBlocking;

  return (
    <Dialog open={open} onOpenChange={() => { /* require explicit choice */ }}>
      <DialogContent
        className="max-w-xl"
        onInteractOutside={(e) => {
          if (request.requireExplicit) e.preventDefault();
          else onDecide("deny-once");
        }}
        onEscapeKeyDown={(e) => {
          if (request.requireExplicit) e.preventDefault();
          else onDecide("deny-once");
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            허용 디렉토리 외부 접근
            {request.trustOrigin && (
              <Badge variant="outline" className="ml-2 text-[11px]">
                {request.trustOrigin}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            도구 <code className="rounded bg-muted px-1 py-0.5 font-mono">{request.toolName}</code>{" "}
            가 현재 허용 디렉토리 목록 외부의 경로에 접근하려 합니다. 이번 1회만
            허용할지, 디렉토리를 영구 목록에 추가할지, 아니면 거부할지 선택하세요.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <section>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              요청 경로
            </p>
            <p className="rounded bg-muted px-2 py-1 text-sm font-mono">
              {candidatePath}
            </p>
          </section>

          <section>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              현재 허용 디렉토리 ({currentAllowed.length}개)
            </p>
            <ul className="max-h-24 overflow-y-auto rounded border bg-muted/50 p-2 text-xs font-mono">
              {currentAllowed.length === 0 ? (
                <li className="text-muted-foreground">— 없음 —</li>
              ) : (
                currentAllowed.map((d) => <li key={d}>{d}</li>)
              )}
            </ul>
          </section>

          {suggestedParent && (
            <section>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                추천 추가 위치 (leaf-parent)
              </p>
              <p className="rounded bg-blue-500/10 px-2 py-1 text-sm font-mono text-blue-700 dark:text-blue-400">
                {suggestedParent}
              </p>
            </section>
          )}

          {adjacencyWarnings.length > 0 && (
            <section className="rounded border border-red-500/40 bg-red-500/10 p-2 text-sm">
              <p className="mb-1 font-medium text-red-700 dark:text-red-400">
                주의 — 인접 경고
              </p>
              <ul className="ml-4 list-disc text-xs text-red-700 dark:text-red-400">
                {adjacencyWarnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
              <label className="mt-2 flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={acknowledgedAdjacency}
                  onChange={(e) => setAcknowledgedAdjacency(e.target.checked)}
                />
                위 경고를 이해했고 진행을 원합니다.
              </label>
            </section>
          )}

          <section className="rounded border bg-muted/30 p-2">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              영구 추가 확인 (피싱 방지) — &ldquo;{confirmName}&rdquo; 를 정확히 입력하세요
            </p>
            <Input
              value={retypeValue}
              onChange={(e) => setRetypeValue(e.target.value)}
              placeholder={confirmName}
              className="font-mono text-sm"
            />
          </section>
        </div>

        <DialogFooter className="flex flex-row justify-end gap-2">
          <Button variant="ghost" onClick={() => onDecide("deny-once")}>
            거부
          </Button>
          <Button variant="outline" onClick={() => onDecide("allow-once")}>
            한 번만 허용
          </Button>
          <Button
            disabled={!persistEnabled || !suggestedParent}
            onClick={() => {
              if (!suggestedParent) return;
              onDecide("allow-always", suggestedParent);
            }}
          >
            디렉토리 영구 추가
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
