/**
 * Issue #690 follow-up — one-shot "권한 정책이 업데이트되었습니다" banner.
 *
 * Why: legacy users upgrading past PR #698 may have their permission
 * settings file silently migrated by `migratePermissionSettings()` at
 * boot (e.g. `executionMode = "auto"` → `reviewer.interactive.autoApprove
 * = "low"`). Without an in-product surface, those users would only
 * notice the change when a tool call's modal behaviour differs from
 * their memory of the prior UX. The banner gives them a one-tap path to
 * the PermissionsTab so they can review the new defaults.
 *
 * Behaviour:
 *   - Mounts → calls `permission.getMigrationStatus()` once.
 *   - Hidden when `appliedAt` is absent (fresh install / not migrated).
 *   - Hidden when localStorage flag
 *     `permission-migration-banner-${schemaVersion}-dismissed` is "true".
 *   - "지금 확인" → `onOpenSettings("permissions")` then auto-dismiss.
 *   - "다음에" / X → persist dismissed flag, hide.
 *
 * Per-schemaVersion dismissal: keying the LocalStorage flag on the
 * applied schemaVersion lets a future v2→v3 migration re-surface the
 * banner without users having to reset the prior dismissal.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";

const DISMISS_KEY_PREFIX = "permission-migration-banner-v";

function dismissedKey(schemaVersion: number): string {
  return `${DISMISS_KEY_PREFIX}${schemaVersion}-dismissed`;
}

function readDismissed(schemaVersion: number): boolean {
  try {
    return window.localStorage.getItem(dismissedKey(schemaVersion)) === "true";
  } catch {
    return false;
  }
}

function persistDismissed(schemaVersion: number): void {
  try {
    window.localStorage.setItem(dismissedKey(schemaVersion), "true");
  } catch {
    // localStorage unavailable (private mode etc.) — fine, banner will
    // re-appear next mount until storage works.
  }
}

export interface PermissionMigrationBannerProps {
  onOpenSettings: (tab: string) => void;
}

export function PermissionMigrationBanner({
  onOpenSettings,
}: PermissionMigrationBannerProps) {
  const [schemaVersion, setSchemaVersion] = useState<number | null>(null);
  const [appliedAt, setAppliedAt] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const api = window.lvis?.permission?.getMigrationStatus;
    if (!api) return;
    void (async () => {
      try {
        const r = await api();
        if (cancelled || !r.ok) return;
        if (!r.appliedAt || typeof r.schemaVersion !== "number") return;
        if (readDismissed(r.schemaVersion)) {
          setDismissed(true);
          return;
        }
        setSchemaVersion(r.schemaVersion);
        setAppliedAt(r.appliedAt);
      } catch {
        // IPC error — banner stays hidden; the user will see the
        // up-to-date settings via the next interaction.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    if (typeof schemaVersion === "number") persistDismissed(schemaVersion);
    setDismissed(true);
  }, [schemaVersion]);

  const handleOpenSettings = useCallback(() => {
    onOpenSettings("permissions");
    dismiss();
  }, [onOpenSettings, dismiss]);

  if (dismissed || !appliedAt || schemaVersion === null) return null;

  return (
    <div
      className="flex items-center justify-between gap-2 bg-info/15 border border-info/40 text-info text-sm px-4 py-2 rounded-md mx-2 mt-2 lvis-anim-slide-down"
      data-testid="permission-migration-banner"
      data-schema-version={schemaVersion}
    >
      <span>
        권한 정책이 업데이트되었습니다. 새 자동 승인 옵션을 확인해 주세요.
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="default"
          size="sm"
          onClick={handleOpenSettings}
          data-testid="permission-migration-banner-action"
          className="h-7 text-[12px]"
        >
          지금 확인
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={dismiss}
          aria-label="권한 정책 업데이트 알림 닫기"
          data-testid="permission-migration-banner-dismiss"
          className="text-info hover:text-info/80 h-auto p-1"
        >
          ✕
        </Button>
      </div>
    </div>
  );
}
