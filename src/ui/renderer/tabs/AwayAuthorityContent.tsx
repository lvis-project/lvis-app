import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import type { AwayAuthorityStatus } from "../../../shared/away-authority-arm.js";
import { AwayAuthorityArmDialog } from "../components/AwayAuthorityArmDialog.js";
import { formatIpcError } from "../format-ipc-error.js";
import { formatMediumDateTime } from "../../../shared/format-time.js";
import type { LvisApi } from "../types.js";

export interface AwayAuthorityContentProps {
  api: LvisApi;
  /**
   * The tile the away-authority grant would bind to — the focused conversation.
   * Threaded from the window because settings has no conversation of its own,
   * and main refuses a grant that names no tile.
   */
  chatGroupId: string;
  /**
   * Whether the paired Telegram share can actually raise an approval in the
   * conversation on screen. A grant binds to the open conversation and answers
   * nothing else, so arming while some other conversation is shared would
   * produce a grant that can only ever refuse.
   */
  shareIsLive: boolean;
}

/**
 * Desk controls for the away answerer, shown beside the Telegram share it
 * answers for.
 *
 * The renderer holds no authority of its own: `status` is main's answer to
 * "what can be answered right now", refetched after every mutation. Main treats
 * an expired grant as nothing armed, so this component never has to decide
 * whether a stale `expiresAt` still counts — but it does schedule one refetch
 * for the moment the grant expires, because otherwise a desk left open would go
 * on displaying "armed" for a grant that can no longer answer anything.
 */
export function AwayAuthorityContent({ api, chatGroupId, shareIsLive }: AwayAuthorityContentProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AwayAuthorityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [arming, setArming] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await api.awayAuthority.status();
      if (!result.ok) {
        setStatus(null);
        setError(formatIpcError(result.error, undefined));
        return;
      }
      setStatus(result.status);
      setError(null);
    } catch {
      setStatus(null);
      setError(t("awayAuthority.operationFailed"));
    }
  }, [api, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (status === null) return;
    // One timer for the expiry instant, not a poll. `setTimeout` clamps at
    // ~24.8 days and the longest grant is hours, so the delay is always exact.
    const delay = Math.max(0, status.expiresAt - Date.now());
    const timer = setTimeout(() => { void refresh(); }, delay);
    return () => clearTimeout(timer);
  }, [refresh, status]);

  const disarm = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api.awayAuthority.disarm();
      if (!result.ok) {
        setError(formatIpcError(result.error, undefined));
        return;
      }
      setError(null);
      await refresh();
    } catch {
      setError(t("awayAuthority.operationFailed"));
    } finally {
      setBusy(false);
    }
  }, [api, refresh, t]);

  return (
    <div className="space-y-2" data-testid="away-authority-content">
      <p className="text-xs font-medium">{t("awayAuthority.sectionTitle")}</p>
      <p className="text-[11px] text-muted-foreground">
        {t("awayAuthority.sectionDescription")}
      </p>

      {error !== null ? (
        <p role="alert" className="text-xs text-destructive" data-testid="away-authority-error">
          {error}
        </p>
      ) : null}

      {status === null ? (
        <p className="text-xs text-muted-foreground" data-testid="away-authority-not-armed">
          {t("awayAuthority.notArmed")}
        </p>
      ) : (
        <div
          className="rounded-md border border-primary/(--opacity-medium) bg-primary/(--opacity-subtle) px-3 py-2"
          data-testid="away-authority-armed"
        >
          <p className="text-xs font-medium">
            {status.writable
              ? t("awayAuthority.armedReadWrite")
              : t("awayAuthority.armedRead")}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("awayAuthority.armedDetail", {
              count: status.remaining,
              time: formatMediumDateTime(status.expiresAt),
            })}
          </p>
          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
            {t("awayAuthority.armedFolders", { folders: status.directories.join(", ") })}
          </p>
        </div>
      )}

      {status === null && !shareIsLive ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="away-authority-requires-open-shared-conversation"
        >
          {t("awayAuthority.requiresOpenSharedConversation")}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {status === null ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !shareIsLive}
            onClick={() => setArming(true)}
            data-testid="away-authority-open-arm-dialog"
          >
            {t("awayAuthority.arm")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void disarm()}
            data-testid="away-authority-disarm"
          >
            {t("awayAuthority.disarm")}
          </Button>
        )}
      </div>

      <AwayAuthorityArmDialog
        api={api}
        chatGroupId={chatGroupId}
        open={arming}
        onCancel={() => setArming(false)}
        onArmed={() => {
          setArming(false);
          void refresh();
        }}
      />
    </div>
  );
}
