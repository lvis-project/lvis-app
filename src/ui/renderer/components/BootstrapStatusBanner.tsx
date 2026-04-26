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
}

export function BootstrapStatusBanner({ status, onDismiss }: Props): React.ReactElement | null {
  if (!status) return null;

  if (status.phase === "start") {
    return (
      <div className="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 text-slate-700 text-sm px-4 py-2 rounded-md mx-2 mt-2">
        <span>매니지드 플러그인 설치 중…</span>
      </div>
    );
  }

  if (status.phase === "error") {
    return (
      <div className="flex items-center justify-between gap-2 bg-red-50 border border-red-200 text-red-800 text-sm px-4 py-2 rounded-md mx-2 mt-2">
        <span>플러그인 부트스트랩 실패: {status.message}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label="알림 닫기"
          className="text-red-700 hover:text-red-900 h-auto p-1"
        >
          ✕
        </Button>
      </div>
    );
  }

  // phase === "complete"
  if (status.skippedReason) {
    return (
      <div className="flex items-center justify-between gap-2 bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-2 rounded-md mx-2 mt-2">
        <span>마켓플레이스 부트스트랩 건너뜀: {status.skippedReason}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label="알림 닫기"
          className="text-amber-700 hover:text-amber-900 h-auto p-1"
        >
          ✕
        </Button>
      </div>
    );
  }

  if (status.failed.length > 0) {
    const summary =
      status.failed.length === 1
        ? `플러그인 ${status.failed[0].id} 설치 실패: ${status.failed[0].error}`
        : `${status.failed.length}개 플러그인 설치 실패`;
    return (
      <div className="flex items-center justify-between gap-2 bg-red-50 border border-red-200 text-red-800 text-sm px-4 py-2 rounded-md mx-2 mt-2">
        <span>{summary}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label="알림 닫기"
          className="text-red-700 hover:text-red-900 h-auto p-1"
        >
          ✕
        </Button>
      </div>
    );
  }

  // complete + nothing failed + not skipped → silent.
  return null;
}
