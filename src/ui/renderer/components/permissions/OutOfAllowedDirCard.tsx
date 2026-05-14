/**
 * Out-of-allowed-dir approval card.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 1.
 *
 * Renderer routes here when `ApprovalRequest.kind === "out-of-allowed-dir"`.
 * UX rules (security review M3 strengthening):
 *
 *   1. Three-button choice — "한 번만 허용" / "디렉토리 영구 추가" / "거부".
 *   2. "디렉토리 영구 추가" requires re-typed confirmation (phishing
 *      defense): user must re-type the suggested-parent directory path
 *      before the persist button is enabled.
 *   3. Adjacency warnings rendered as a red banner with explicit opt-in.
 *   4. Auto-suggest leaf-parent only — never the broadest common-prefix.
 *
 * Layered IPC: this component does NOT directly write settings. The
 * "디렉토리 영구 추가" choice is surfaced as
 * `choice: "allow-always" + rememberPattern: <suggestedParent>` so the
 * existing approval-respond pipeline carries the persist intent back to main,
 * where the permission-rule dispatcher validates and persists the directory.
 */
import { useEffect, useState } from "react";
import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import { Checkbox } from "../../../../components/ui/checkbox.js";
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
import { isNonUserTrustOrigin, trustOriginLabel } from "../../utils/trust-origin-label.js";
import { PermissionEvaluationContextPanel } from "./PermissionEvaluationContextPanel.js";

interface OutOfAllowedDirCardProps {
  open: boolean;
  request: ApprovalRequest | null;
  onDecide: (choice: ApprovalChoice, rememberPattern?: string) => void;
}

/**
 * Derive the full path for the re-typed confirmation prompt. A basename-only
 * gate is ambiguous across unrelated directories with the same leaf name.
 */
function deriveConfirmName(req: ApprovalRequest): string {
  return req.outOfAllowedDir?.suggestedParent
    ?? req.outOfAllowedDir?.candidatePath
    ?? "";
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
  const originLabel = trustOriginLabel(request.trustOrigin);
  const warnOrigin = isNonUserTrustOrigin(request.trustOrigin);

  return (
    <Dialog open={open} onOpenChange={() => { /* require explicit choice */ }}>
      <DialogContent
        size="lg"
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
            <Badge variant="outline" className="ml-2 text-[11px]">
              {originLabel}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            도구 <code className="rounded bg-muted px-1 py-0.5 font-mono">{request.toolName}</code>{" "}
            가 현재 허용 디렉토리 목록 외부의 경로에 접근하려 합니다. 이번 1회만
            허용할지, 디렉토리를 영구 목록에 추가할지, 아니면 거부할지 선택하세요.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {warnOrigin && (
            <section className="rounded border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-warning">
              이 디렉토리 접근은 {originLabel}에서 시작되었습니다. 영구 허용은 이후 같은 범위의 파일 접근을 계속 허용합니다.
            </section>
          )}

          <section>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              요청 경로
            </p>
            <p className="rounded bg-muted px-2 py-1 text-sm font-mono break-all">
              {candidatePath}
            </p>
          </section>

          <section>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              현재 허용 디렉토리 ({currentAllowed.length}개)
            </p>
            <ul className="max-h-24 overflow-y-auto rounded border bg-muted/50 p-2 text-xs font-mono break-all">
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
                추천 추가 디렉토리
              </p>
              <p className="rounded bg-info/10 px-2 py-1 text-sm font-mono text-info break-all">
                {suggestedParent}
              </p>
            </section>
          )}

          {adjacencyWarnings.length > 0 && (
            <section className="rounded border border-destructive/40 bg-destructive/10 p-2 text-sm">
              <p className="mb-1 font-medium text-destructive">
                주의 — 인접 경고
              </p>
              <ul className="ml-4 list-disc text-xs text-destructive">
                {adjacencyWarnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
              <label className="mt-2 flex items-center gap-2 text-xs">
                <Checkbox
                  checked={acknowledgedAdjacency}
                  onCheckedChange={(checked) => setAcknowledgedAdjacency(checked === true)}
                  data-testid="adjacency-warning-ack"
                />
                위 경고를 이해했고 진행을 원합니다.
              </label>
            </section>
          )}

          <PermissionEvaluationContextPanel context={request.evaluationContext} />

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

        <DialogFooter className="gap-2 sm:gap-2">
          <Button className="w-full sm:w-auto" variant="ghost" onClick={() => onDecide("deny-once")}>
            거부
          </Button>
          <Button className="w-full sm:w-auto" variant="outline" onClick={() => onDecide("allow-once")}>
            한 번만 허용
          </Button>
          <Button
            className="w-full sm:w-auto"
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
