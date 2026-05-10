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
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Badge } from "../../../../components/ui/badge.js";

export type ModeBadgeVariant = "default" | "strict" | "auto" | "allow" | "unknown";

export interface PermissionModeBadgeProps {
  /** Override mode resolution for tests/storybook. */
  mode?: ModeBadgeVariant;
  /** Override fetcher. Defaults to window.lvis.permission.getMode(). */
  fetcher?: () => Promise<{ mode: string }>;
  /** Override deferred approval fetcher for tests/storybook. */
  deferredFetcher?: () => Promise<{ ok: boolean; pending?: unknown[] }>;
  /** Override deferred approval subscription for tests/storybook. */
  deferredSubscriber?: (handler: (summary: { pending: number }) => void) => () => void;
  /** Optional click handler — typically opens the Settings → Permissions tab. */
  onClick?: () => void;
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
  default: "border-blue-500 text-blue-700 dark:text-blue-400",
  strict: "border-red-500 text-red-700 dark:text-red-400",
  auto: "border-amber-500 text-amber-700 dark:text-amber-400",
  allow: "border-emerald-500 text-emerald-700 dark:text-emerald-400",
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
  subscribe,
}: PermissionModeBadgeProps): ReactElement {
  const [mode, setMode] = useState<ModeBadgeVariant>(modeOverride ?? "unknown");
  const [pendingPermissions, setPendingPermissions] = useState(0);

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
        if (alive && result.ok) setPendingPermissions(result.pending?.length ?? 0);
      } catch {
        if (alive) setPendingPermissions(0);
      }
    };
    void refreshPending();
    const sub = deferredSubscriber ?? window.lvis?.permission?.onDeferredPending;
    const unsubscribe = sub?.((summary) => {
      setPendingPermissions(Math.max(0, summary.pending));
    });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [apiFetchDeferred, deferredSubscriber]);

  const handleClick = useCallback(() => {
    if (onClick) onClick();
  }, [onClick]);

  const pendingText = pendingPermissions > 0 ? `, 대기 승인 ${pendingPermissions}건` : "";

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1 rounded-full focus:outline-none focus:ring-2 focus:ring-ring"
      title={`${MODE_DESCRIPTIONS[mode]}${pendingText}`}
      aria-label={`현재 권한 정책: ${MODE_DESCRIPTIONS[mode]}${pendingText}`}
      data-testid="permission-mode-badge"
      data-mode={mode}
    >
      <Badge variant="outline" className={`text-[10px] ${MODE_COLOR_CLASSES[mode]}`}>
        {MODE_LABELS[mode]}
      </Badge>
      {pendingPermissions > 0 && (
        <Badge
          variant="outline"
          className="border-destructive bg-destructive/10 px-1.5 text-[10px] text-destructive"
          data-testid="permission-pending-badge"
        >
          승인 {pendingPermissions}
        </Badge>
      )}
    </button>
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
