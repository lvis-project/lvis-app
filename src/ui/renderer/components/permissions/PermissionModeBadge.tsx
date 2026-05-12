/**
 * Permission policy mode badge.
 *
 * Compact mode indicator displayed in the chat header. Shows the
 * active permission mode (default | strict | auto | allow) with color coding
 * + tooltip explaining the mode's behavior.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3
 * Layer 8 — runtime mode switching via `/permission mode ...`.
 *
 * Polls `window.lvis.permission.getMode()` on mount + on a custom
 * `lvis:permissions:mode-changed` window event so user gestures
 * elsewhere (Settings dialog, slash) reflect immediately.
 *
 * Keep this component visual-only. Mode mutation lives in the slash
 * dispatcher + Settings tab; the badge is read-only.
 */
import { Inbox } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Badge } from "../../../../components/ui/badge.js";

export type ModeBadgeVariant = "default" | "strict" | "auto" | "allow" | "unknown";

export interface PermissionModeBadgeProps {
  /** Override mode resolution for tests/storybook. */
  mode?: ModeBadgeVariant;
  /** Override fetcher. Defaults to window.lvis.permission.getMode(). */
  fetcher?: () => Promise<{ mode: string }>;
  /** Override deferred approval fetcher for tests/storybook. */
  deferredFetcher?: () => Promise<{ ok: boolean; pending?: unknown[]; error?: string }>;
  /** Override deferred approval subscription for tests/storybook. */
  deferredSubscriber?: (handler: (summary: { pending: number }) => void) => () => void;
  /** Optional click handler — typically opens the Settings → Permissions tab. */
  onClick?: () => void;
  /** Opens the deferred approval queue modal. Kept separate from mode settings. */
  onQueueClick?: () => void;
  /** Test hook for the change-event subscription. */
  subscribe?: (handler: (mode: ModeBadgeVariant) => void) => () => void;
}

const MODE_LABELS: Record<ModeBadgeVariant, string> = {
  default: "기본 · 읽기 허용",
  strict: "전체 물어보기",
  auto: "자동 검증 · 읽기 허용",
  allow: "전체 허용 · 외부경로 승인",
  unknown: "권한 확인",
};

const MODE_DESCRIPTIONS: Record<ModeBadgeVariant, string> = {
  default: "기본: 읽기 허용, 변경 작업 승인 요청",
  strict: "전체 물어보기: 읽기 포함 모든 도구 승인 요청",
  auto: "자동 검증: 저위험 처리 + 헤드리스 백그라운드 리뷰어 검증",
  allow: "전체 허용: 하드 차단 밖 자동 허용, 허용 디렉터리 밖 접근은 별도 승인",
  unknown: "권한 모드 미확인",
};

const MODE_COLOR_CLASSES: Record<ModeBadgeVariant, string> = {
  default: "border-info text-info",
  strict: "border-destructive text-destructive",
  auto: "border-warning text-warning",
  allow: "border-success text-success",
  unknown: "border-muted-foreground text-muted-foreground",
};

function normalizeMode(raw: string): ModeBadgeVariant {
  if (raw === "default" || raw === "strict" || raw === "auto" || raw === "allow") return raw;
  return "unknown";
}

export function PermissionModeBadge({
  mode: modeOverride,
  fetcher,
  deferredFetcher,
  deferredSubscriber,
  onClick,
  onQueueClick,
  subscribe,
}: PermissionModeBadgeProps): ReactElement {
  const [mode, setMode] = useState<ModeBadgeVariant>(modeOverride ?? "unknown");
  const [pendingPermissions, setPendingPermissions] = useState(0);
  const [pendingError, setPendingError] = useState<string | null>(null);

  const apiFetch = useMemo(
    () => fetcher ?? (() => window.lvis!.permission!.getMode()),
    [fetcher],
  );

  const apiFetchDeferred = useMemo(
    () => deferredFetcher ?? (() => window.lvis?.permission?.deferredList?.() ?? Promise.resolve({ ok: false })),
    [deferredFetcher],
  );

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch();
      setMode(normalizeMode(r.mode));
    } catch {
      setMode("unknown");
    }
  }, [apiFetch]);

  useEffect(() => {
    if (modeOverride !== undefined) {
      setMode(modeOverride);
      return;
    }
    void refresh();
    const sub = subscribe ?? defaultModeSubscriber;
    const unsubscribe = sub((newMode) => setMode(newMode));
    return () => {
      unsubscribe();
    };
  }, [modeOverride, refresh, subscribe]);

  useEffect(() => {
    let alive = true;
    const refreshPending = async () => {
      try {
        const result = await apiFetchDeferred();
        if (!alive) return;
        if (result.ok) {
          setPendingPermissions(result.pending?.length ?? 0);
          setPendingError(null);
        } else {
          setPendingPermissions(0);
          setPendingError(result.error ?? "deferred-list failed");
        }
      } catch {
        if (alive) {
          setPendingPermissions(0);
          setPendingError("deferred-list failed");
        }
      }
    };
    void refreshPending();
    const sub = deferredSubscriber ?? window.lvis?.permission?.onDeferredPending;
    const unsubscribe = sub?.((summary) => {
      setPendingPermissions(Math.max(0, summary.pending));
      setPendingError(null);
    });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [apiFetchDeferred, deferredSubscriber]);

  const handleClick = useCallback(() => {
    if (onClick) onClick();
  }, [onClick]);

  const queueVisible = pendingPermissions > 0 || pendingError !== null;
  const pendingText = pendingError
    ? `, 큐 상태 확인 실패: ${pendingError}`
    : pendingPermissions > 0
      ? `, 대기 승인 ${pendingPermissions}건`
      : "";
  const queueLabel = pendingError ? "승인 확인 실패" : `승인 ${pendingPermissions}`;

  return (
    <div className="inline-flex items-center gap-1" data-testid="permission-policy-controls">
      <button
        type="button"
        onClick={handleClick}
        className="inline-flex items-center rounded-full focus:outline-none focus:ring-2 focus:ring-ring"
        title={MODE_DESCRIPTIONS[mode]}
        aria-label={`현재 권한 정책: ${MODE_DESCRIPTIONS[mode]}`}
        data-testid="permission-mode-badge"
        data-mode={mode}
      >
        <Badge variant="outline" className={`text-[10px] ${MODE_COLOR_CLASSES[mode]}`}>
          {MODE_LABELS[mode]}
        </Badge>
      </button>
      {queueVisible && (
        <button
          type="button"
          onClick={onQueueClick}
          disabled={!onQueueClick}
          className="inline-flex items-center rounded-full focus:outline-none focus:ring-2 focus:ring-ring"
          title={`보류된 승인 큐 열기${pendingText}`}
          aria-label={`보류된 승인 큐 열기${pendingText}`}
          data-testid="permission-queue-button"
        >
          <Badge
            variant="outline"
            className="inline-flex items-center gap-1 border-destructive bg-destructive/10 px-2 text-[10px] text-destructive"
            data-testid="permission-pending-badge"
          >
            <Inbox className="h-3 w-3" aria-hidden="true" />
            {queueLabel}
          </Badge>
        </button>
      )}
    </div>
  );
}

/**
 * Default subscription path — wires a `mode-changed` window event so
 * the badge updates without prop-drilling state through every chat
 * surface that hosts it. The event is dispatched by the slash
 * dispatcher when a `mode_change` audit row lands.
 */
function defaultModeSubscriber(handler: (mode: ModeBadgeVariant) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ mode: string }>).detail;
    if (detail?.mode) handler(normalizeMode(detail.mode));
  };
  window.addEventListener("lvis:permissions:mode-changed", listener);
  return () => window.removeEventListener("lvis:permissions:mode-changed", listener);
}
