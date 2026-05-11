// Phase 2d — managed bootstrap status banner.
//
// Renders one of three states based on the IPC event from the host:
//   - start    → "플러그인 설치 중…" (no dismiss; host will emit terminal soon)
//   - complete with failed[] → red banner listing failures, dismissable
//   - complete with skippedReason → amber banner ("마켓플레이스 미설정")
//   - error    → red banner with the host-supplied message
//   - complete clean → silent (return null) — most users see nothing
//
// The renderer hook supplies `status` + `dismiss`. Banner does not auto-
// dismiss; the user closes it (success state never renders, so there's
// nothing to auto-clear).

import { Button } from "../../../components/ui/button.js";
import type { BootstrapStatusEvent } from "../hooks/use-bootstrap-status.js";

interface Props {
  status: BootstrapStatusEvent | null;
  onDismiss: () => void;
  onRetry: () => void;
}

export function BootstrapStatusBanner({ status, onDismiss, onRetry }: Props): React.ReactElement | null {
  if (!status) return null;

  if (status.phase === "start") {
    return (
      <div className="flex items-center justify-between gap-2 bg-muted border border-border text-muted-foreground text-sm px-4 py-2 rounded-md mx-2 mt-2 lvis-anim-slide-down">
        <span>매니지드 플러그인 설치 중…</span>
      </div>
    );
  }

  if (status.phase === "error") {
    return (
      <div className="flex items-center justify-between gap-2 bg-destructive/15 border border-destructive/40 text-destructive text-sm px-4 py-2 rounded-md mx-2 mt-2 lvis-anim-slide-down">
        <span>플러그인 부트스트랩 실패: {status.message}</span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="h-auto px-2 py-0.5 text-xs text-destructive border-destructive/40 hover:bg-destructive/15"
          >
            다시 시도
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            aria-label="알림 닫기"
            className="text-destructive hover:text-destructive/80 h-auto p-1"
          >
            ✕
          </Button>
        </div>
      </div>
    );
  }

  // phase === "complete"
  if (status.skippedReason) {
    return (
      <div className="flex items-center justify-between gap-2 bg-warning/15 border border-warning/40 text-warning text-sm px-4 py-2 rounded-md mx-2 mt-2 lvis-anim-slide-down">
        <span>마켓플레이스 부트스트랩 건너뜀: {status.skippedReason}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label="알림 닫기"
          className="text-warning hover:text-warning/80 h-auto p-1"
        >
          ✕
        </Button>
      </div>
    );
  }

  if (status.failed.length > 0) {
    // Truncate long error strings (e.g. multi-line stack traces from
    // tarball failures) so the banner stays single-line on narrow screens.
    const truncate = (s: string, max = 120): string =>
      s.length > max ? `${s.slice(0, max - 1)}…` : s;
    const summary =
      status.failed.length === 1
        ? `플러그인 ${status.failed[0].id} 설치 실패: ${truncate(status.failed[0].error)}`
        : `${status.failed.length}개 플러그인 설치 실패`;
    return (
      <div className="flex items-center justify-between gap-2 bg-destructive/15 border border-destructive/40 text-destructive text-sm px-4 py-2 rounded-md mx-2 mt-2 lvis-anim-slide-down">
        <span>{summary}</span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="h-auto px-2 py-0.5 text-xs text-destructive border-destructive/40 hover:bg-destructive/15"
          >
            다시 시도
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            aria-label="알림 닫기"
            className="text-destructive hover:text-destructive/80 h-auto p-1"
          >
            ✕
          </Button>
        </div>
      </div>
    );
  }

  // complete + nothing failed + not skipped → silent.
  return null;
}
