/**
 * Q12 Phase 4 — Layer 6 hook TOFU trust modal.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 6.
 *
 * Surfaces the diff between `~/.config/lvis/hooks/*.sh` files on disk
 * and the `.lockfile.json`. The user picks per-file whether to trust
 * (add to lockfile, hook will run on subsequent boots) or reject
 * (relocate to `.disabled/`, hook will not run).
 *
 * UX rules:
 *   - Default: every entry is *unchecked* (deny-by-default). User must
 *     deliberately tick "Trust" for each file they want to enable.
 *   - "Reject all" is the safer one-click path; "Trust selected" is
 *     gated by an explicit confirmation step.
 *   - Hash + previousHash shown for `changed` entries so the user can
 *     see what drifted.
 *   - Modal stays open until the user makes a decision — boot is
 *     blocked. The renderer is expected to mount this at startup
 *     before any other UI claims focus.
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

export interface HookTrustModalFile {
  fileName: string;
  state: "new" | "changed" | "trusted" | "removed";
  sha256: string;
  previousSha256?: string;
}

export interface HookTrustModalRequest {
  id: string;
  files: HookTrustModalFile[];
}

interface Props {
  open: boolean;
  request: HookTrustModalRequest | null;
  /** Sends per-file decisions back to main. */
  onAccept: (id: string, trustedFileNames: string[]) => Promise<void> | void;
  /** Convenience reject-all action. */
  onRejectAll: (id: string) => Promise<void> | void;
}

export function HookTrustModal({ open, request, onAccept, onRejectAll }: Props) {
  // Per-file checkbox state — keyed by fileName. Default false (deny-by-default).
  const [trusted, setTrusted] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (request) {
      const initial: Record<string, boolean> = {};
      for (const f of request.files) initial[f.fileName] = false;
      setTrusted(initial);
    } else {
      setTrusted({});
    }
  }, [request?.id]);

  if (!request) return null;

  // Filter `removed` from the actionable list — those are informational
  // (file already gone, no UX needed). Surface them in a footer note.
  const actionable = request.files.filter((f) => f.state !== "removed");
  const removed = request.files.filter((f) => f.state === "removed");

  const trustedCount = Object.values(trusted).filter(Boolean).length;

  const handleAccept = async () => {
    setSubmitting(true);
    try {
      const trustedNames = Object.entries(trusted)
        .filter(([, v]) => v)
        .map(([k]) => k);
      await onAccept(request.id, trustedNames);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRejectAll = async () => {
    setSubmitting(true);
    try {
      await onRejectAll(request.id);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Layer 6 Hook Trust Prompt</DialogTitle>
          <DialogDescription>
            새/변경된 hook 스크립트가 <code>~/.config/lvis/hooks/</code>에서 발견되었습니다.
            각 파일을 확인하고 신뢰할 항목만 체크하세요. 체크하지 않은 파일은
            <code>.disabled/</code>로 이동되어 실행되지 않습니다.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 max-h-96 overflow-y-auto">
          {actionable.map((f) => (
            <div
              key={f.fileName}
              className="flex items-start gap-3 rounded border p-3"
            >
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={trusted[f.fileName] ?? false}
                onChange={(e) =>
                  setTrusted((prev) => ({ ...prev, [f.fileName]: e.target.checked }))
                }
                aria-label={`Trust ${f.fileName}`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{f.fileName}</span>
                  <Badge variant={f.state === "new" ? "default" : "secondary"}>
                    {f.state}
                  </Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground font-mono">
                  sha256: <span title={f.sha256}>{f.sha256.slice(0, 16)}…</span>
                  {f.state === "changed" && f.previousSha256 ? (
                    <>
                      <br />
                      previous:{" "}
                      <span title={f.previousSha256}>
                        {f.previousSha256.slice(0, 16)}…
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>

        {removed.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {removed.length}개의 잠금 파일에 등록된 hook 이 디스크에서 사라져 있습니다.
            잠금 파일은 자동으로 정리됩니다.
          </p>
        ) : null}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="destructive"
            onClick={handleRejectAll}
            disabled={submitting}
          >
            모두 거부 (Disable all)
          </Button>
          <Button onClick={handleAccept} disabled={submitting}>
            {trustedCount > 0
              ? `Trust ${trustedCount} hook${trustedCount === 1 ? "" : "s"}`
              : "선택 항목 신뢰"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
