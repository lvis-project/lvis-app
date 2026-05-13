/**
 * Issue #690 follow-up / PR #704 — one-shot permission migration banner.
 *
 * Why: legacy users upgrading past PR #698 may have their permission
 * settings file silently migrated by the boot-time migration step
 * (e.g. `executionMode === "auto"` with no on-disk `interactive` block
 * → `interactive.autoApprove = "low"`). Without an in-product surface,
 * those users would only notice the change when a tool call's modal
 * behaviour differs from their memory of the prior UX. The banner
 * gives them a one-tap path to the PermissionsTab so they can review.
 *
 * Visibility predicate:
 *   - `permission.getMigrationStatus()` returns `behaviourChanged: true`
 *     (i.e. the migrator actually flipped a setting), AND
 *   - localStorage flag
 *     `permission-migration-banner-v${schemaVersion}-dismissed` is NOT
 *     "true".
 *
 *   Pure schema-version bumps return `behaviourChanged: false` and the
 *   banner stays hidden — see issue #704 review (architect MAJOR-5,
 *   designer M1).
 *
 * Buttons:
 *   - "지금 확인" → `onOpenSettings("permissions")` then auto-dismiss.
 *   - "다음에" (ghost button) → persist the dismissal flag, hide.
 *   - "✕" (icon-only) → same as "다음에", offered for users who
 *     prefer the conventional close affordance.
 *
 * Visual: amber accent (vs the marketplace banner's info-blue) so when
 * both banners stack vertically a beginner can tell them apart at a
 * glance (designer m4).
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
  const [behaviourChanged, setBehaviourChanged] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const api = window.lvis?.permission?.getMigrationStatus;
    if (!api) return;
    void (async () => {
      try {
        const r = await api();
        if (cancelled || !r.ok) return;
        if (!r.behaviourChanged) return;
        if (typeof r.schemaVersion !== "number") return;
        if (readDismissed(r.schemaVersion)) {
          setDismissed(true);
          return;
        }
        setSchemaVersion(r.schemaVersion);
        setBehaviourChanged(true);
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

  if (dismissed || !behaviourChanged || schemaVersion === null) return null;

  return (
    <div
      className="flex items-center justify-between gap-2 bg-warning/15 border border-warning/40 text-warning-foreground text-sm px-4 py-2 rounded-md mx-2 mt-2 lvis-anim-slide-down"
      data-testid="permission-migration-banner"
      data-schema-version={schemaVersion}
    >
      <span>
        이전과 같이 위험도가 낮은 도구는 자동으로 허용되도록 설정이 이전되었습니다. 권한 설정에서 자세히 확인할 수 있습니다.
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
          data-testid="permission-migration-banner-later"
          className="h-7 text-[12px]"
        >
          다음에
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={dismiss}
          aria-label="권한 정책 업데이트 알림 닫기"
          data-testid="permission-migration-banner-dismiss"
          className="text-warning-foreground/80 hover:text-warning-foreground h-auto p-1"
        >
          <span aria-hidden="true">✕</span>
        </Button>
      </div>
    </div>
  );
}
