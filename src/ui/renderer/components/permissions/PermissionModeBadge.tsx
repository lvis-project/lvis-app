/**
 * Permission policy Phase 5 — PermissionModeBadge.
 *
 * Compact mode indicator displayed in the chat header. Shows the
 * active permission mode (default | strict | auto) with color coding
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

export type ModeBadgeVariant = "default" | "strict" | "auto" | "unknown";

export interface PermissionModeBadgeProps {
  /** Override mode resolution for tests/storybook. */
  mode?: ModeBadgeVariant;
  /** Override fetcher. Defaults to window.lvis.permission.getMode(). */
  fetcher?: () => Promise<{ mode: string }>;
  /** Optional click handler — typically opens the Settings → Permissions tab. */
  onClick?: () => void;
  /** Test hook for the change-event subscription. */
  subscribe?: (handler: (mode: ModeBadgeVariant) => void) => () => void;
}

const MODE_DESCRIPTIONS: Record<ModeBadgeVariant, string> = {
  default: "기본: 위험한 도구만 승인 요청",
  strict: "엄격: 모든 도구 승인 요청",
  auto: "자동: 에이전트 판단으로 실행 (L1·L2 검사는 유지)",
  unknown: "권한 모드 미확인",
};

const MODE_COLOR_CLASSES: Record<ModeBadgeVariant, string> = {
  default: "border-blue-500 text-blue-700 dark:text-blue-400",
  strict: "border-red-500 text-red-700 dark:text-red-400",
  auto: "border-amber-500 text-amber-700 dark:text-amber-400",
  unknown: "border-muted-foreground text-muted-foreground",
};

function normalizeMode(raw: string): ModeBadgeVariant {
  if (raw === "default" || raw === "strict" || raw === "auto") return raw;
  return "unknown";
}

export function PermissionModeBadge({
  mode: modeOverride,
  fetcher,
  onClick,
  subscribe,
}: PermissionModeBadgeProps): ReactElement {
  const [mode, setMode] = useState<ModeBadgeVariant>(modeOverride ?? "unknown");

  const apiFetch = useMemo(
    () => fetcher ?? (() => window.lvis!.permission!.getMode()),
    [fetcher],
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

  const handleClick = useCallback(() => {
    if (onClick) onClick();
  }, [onClick]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1 rounded-full focus:outline-none focus:ring-2 focus:ring-ring"
      title={MODE_DESCRIPTIONS[mode]}
      aria-label={`현재 권한 모드: ${mode}`}
      data-testid="permission-mode-badge"
      data-mode={mode}
    >
      <Badge variant="outline" className={`text-[10px] uppercase ${MODE_COLOR_CLASSES[mode]}`}>
        {mode}
      </Badge>
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
