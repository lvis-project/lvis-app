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
 * `lvis:permissions:mode-changed` events so user gestures elsewhere
 * (Settings window, slash) reflect immediately.
 *
 * Keep this component visual-only. Mode mutation lives in the slash
 * dispatcher + Settings tab; the badge is read-only.
 */
import { Inbox } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";

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

const MODE_LABEL_KEYS: Record<ModeBadgeVariant, string> = {
  default: "permissionModeBadge.labelDefault",
  strict: "permissionModeBadge.labelStrict",
  auto: "permissionModeBadge.labelAuto",
  allow: "permissionModeBadge.labelAllow",
  unknown: "permissionModeBadge.labelUnknown",
};

const MODE_DESCRIPTION_KEYS: Record<ModeBadgeVariant, string> = {
  default: "permissionModeBadge.descDefault",
  strict: "permissionModeBadge.descStrict",
  auto: "permissionModeBadge.descAuto",
  allow: "permissionModeBadge.descAllow",
  unknown: "permissionModeBadge.descUnknown",
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
  const { t } = useTranslation();
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
    ? t("permissionModeBadge.pendingTextError", { error: pendingError })
    : pendingPermissions > 0
      ? t("permissionModeBadge.pendingTextCount", { count: pendingPermissions })
      : "";
  const queueLabel = pendingError
    ? t("permissionModeBadge.queueLabelError")
    : t("permissionModeBadge.queueLabelCount", { count: pendingPermissions });

  return (
    <div className="inline-flex max-w-full min-w-0 items-center gap-1" data-testid="permission-policy-controls">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleClick}
        className="h-auto min-w-0 rounded-full p-0 hover:bg-transparent"
        title={t(MODE_DESCRIPTION_KEYS[mode])}
        aria-label={t("permissionModeBadge.ariaLabelMode", { description: t(MODE_DESCRIPTION_KEYS[mode]) })}
        data-testid="permission-mode-badge"
        data-mode={mode}
      >
        <Badge variant="outline" className={`max-w-[9rem] truncate whitespace-nowrap text-[10px] ${MODE_COLOR_CLASSES[mode]}`}>
          {t(MODE_LABEL_KEYS[mode])}
        </Badge>
      </Button>
      {queueVisible && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onQueueClick}
          disabled={!onQueueClick}
          className="h-auto min-w-0 rounded-full p-0 hover:bg-transparent"
          title={t("permissionModeBadge.queueButtonLabel", { pendingText })}
          aria-label={t("permissionModeBadge.queueButtonLabel", { pendingText })}
          data-testid="permission-queue-button"
        >
          <Badge
            variant="outline"
            className="inline-flex max-w-[7rem] items-center gap-1 truncate whitespace-nowrap border-destructive bg-destructive/(--opacity-subtle) px-2 text-[10px] text-destructive"
            data-testid="permission-pending-badge"
          >
            <Inbox className="h-3 w-3" aria-hidden="true" />
            <span className="min-w-0 truncate">{queueLabel}</span>
          </Badge>
        </Button>
      )}
    </div>
  );
}

/**
 * Default subscription path — wires the preload IPC event plus the legacy
 * local `mode-changed` window event so
 * the badge updates without prop-drilling state through every chat
 * surface that hosts it.
 */
function defaultModeSubscriber(handler: (mode: ModeBadgeVariant) => void): () => void {
  const unsubscribeIpc = window.lvis?.permission?.onModeChanged?.((mode) => {
    handler(normalizeMode(mode));
  });
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ mode: string }>).detail;
    if (detail?.mode) handler(normalizeMode(detail.mode));
  };
  window.addEventListener("lvis:permissions:mode-changed", listener);
  return () => {
    unsubscribeIpc?.();
    window.removeEventListener("lvis:permissions:mode-changed", listener);
  };
}
