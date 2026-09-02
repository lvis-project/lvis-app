import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import {
  NativeSelect,
  NativeSelectOption,
} from "../../../components/ui/native-select.js";
import {
  TAILNET_INVITATION_DURATION_PRESETS,
  TAILNET_SHARE_DURATION_PRESETS,
  type TailnetInvitationDurationPreset,
  type TailnetShareDurationPreset,
  type TailnetSharePermission,
  type TailnetSharingCreatedInvitation,
  type TailnetSharingErrorCode,
  type TailnetSharingMutationResult,
  type TailnetSharingSnapshot,
} from "../../../shared/tailnet-sharing.js";
import { SettingsSection, type SettingsSectionFeedback } from "../components/PageShell.js";
import { TailnetObserverSection } from "./TailnetObserverSection.js";
import { formatMediumDateTime } from "../../../shared/format-time.js";
import type { LvisApi } from "../types.js";
import { useCopyFlash } from "../hooks/use-copy-flash.js";

export interface TailnetAccessContentProps {
  api: LvisApi;
}

function durationLabel(
  value: TailnetInvitationDurationPreset | TailnetShareDurationPreset,
  t: (key: string) => string,
): string {
  switch (value) {
    case "10m": return t("tailnetAccessTab.duration10m");
    case "1h": return t("tailnetAccessTab.duration1h");
    case "8h": return t("tailnetAccessTab.duration8h");
    case "24h": return t("tailnetAccessTab.duration24h");
  }

  return value;
}

function errorText(error: TailnetSharingErrorCode, t: (key: string) => string): string {
  if (error === "user-keyboard-required") return t("tailnetAccessTab.userGestureRequired");
  if (error === "tailnet-sharing-disabled" || error === "tailnet-sharing-unavailable") {
    return t("tailnetAccessTab.disabled");
  }
  return t("tailnetAccessTab.operationFailed");
}

/**
 * Local-owner controls for the Tailnet pairing/share boundary. The renderer may
 * choose a fixed-duration preset and opaque pairing id only; main resolves the
 * current conversation and inserts fresh keyboard intent at the preload edge.
 */
export function TailnetAccessContent({ api }: TailnetAccessContentProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<TailnetSharingSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [feedback, setFeedback] = useState<SettingsSectionFeedback>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [invitationDuration, setInvitationDuration] = useState<TailnetInvitationDurationPreset>("10m");
  const [shareDuration, setShareDuration] = useState<TailnetShareDurationPreset>("8h");
  const [sharePermission, setSharePermission] = useState<TailnetSharePermission>("observe");
  const [issuedInvitation, setIssuedInvitation] = useState<TailnetSharingCreatedInvitation | null>(null);
  const { copied, copy: copyToClipboard, reset: resetCopied } = useCopyFlash();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.tailnetSharing.snapshot();
      if (result.ok) {
        setSnapshot(result.snapshot);
        setDisabled(false);
        return;
      }
      setSnapshot(null);
      setDisabled(result.error === "tailnet-sharing-disabled" || result.error === "tailnet-sharing-unavailable");
      setFeedback({ tone: "error", text: errorText(result.error, t) });
    } catch {
      setSnapshot(null);
      setDisabled(false);
      setFeedback({ tone: "error", text: t("tailnetAccessTab.operationFailed") });
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    void refresh();
    return api.tailnetSharing.onChanged(() => {
      void refresh();
    });
  }, [api, refresh]);

  const activePairings = useMemo(
    () => snapshot?.pairings.filter((pairing) => pairing.state === "active") ?? [],
    [snapshot],
  );

  const runMutation = useCallback(async (
    key: string,
    operation: () => Promise<TailnetSharingMutationResult>,
  ) => {
    setBusy(key);
    setFeedback(null);
    try {
      const result = await operation();
      if (!result.ok) {
        setFeedback({ tone: "error", text: errorText(result.error, t) });
        return;
      }
      setFeedback({ tone: "success", text: t("tailnetAccessTab.operationSucceeded") });
      await refresh();
    } catch {
      setFeedback({ tone: "error", text: t("tailnetAccessTab.operationFailed") });
    } finally {
      setBusy(null);
    }
  }, [refresh, t]);

  const createInvitation = useCallback(async () => {
    setBusy("invitation");
    setFeedback(null);
    resetCopied();
    try {
      const result = await api.tailnetSharing.createInvitation(invitationDuration);
      if (!result.ok) {
        setFeedback({ tone: "error", text: errorText(result.error, t) });
        return;
      }
      // This component state is the sole renderer home of the raw code. A
      // snapshot/change event can never recreate it after unmount.
      setIssuedInvitation(result.invitation);
      setFeedback({ tone: "success", text: t("tailnetAccessTab.operationSucceeded") });
      await refresh();
    } catch {
      setFeedback({ tone: "error", text: t("tailnetAccessTab.operationFailed") });
    } finally {
      setBusy(null);
    }
  }, [api, invitationDuration, refresh, t]);

  const copyInvitation = useCallback(() => {
    if (issuedInvitation) copyToClipboard(issuedInvitation.code);
  }, [copyToClipboard, issuedInvitation]);

  const createShare = useCallback((pairingId: string) => {
    if (sharePermission === "control" && !globalThis.confirm(t("tailnetAccessTab.controlConfirm"))) return;
    void runMutation(
      `share:${pairingId}`,
      () => api.tailnetSharing.createCurrentConversationShare(pairingId, sharePermission, shareDuration),
    );
  }, [api, runMutation, shareDuration, sharePermission, t]);

  return (
    <div className="space-y-6" data-testid="tailnet-access-content">
      <p className="text-sm text-muted-foreground">{t("tailnetAccessTab.pageDescription")}</p>

      {/* Outside the loading and disabled gates below on purpose: this is the
          control that makes sharing available, so hiding it whenever sharing
          is unavailable is exactly the dead end it exists to remove. */}
      <TailnetObserverSection api={api} />

      {feedback ? (
        <p
          role={feedback.tone === "error" ? "alert" : "status"}
          className={feedback.tone === "error"
            ? "rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive"
            : "rounded-md border border-primary/(--opacity-medium) bg-primary/(--opacity-subtle) px-3 py-2 text-xs text-foreground"}
          data-testid="tailnet-access-feedback"
        >
          {feedback.text}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="tailnet-access-loading">
          {t("tailnetAccessTab.loading")}
        </p>
      ) : null}

      {disabled ? (
        <SettingsSection
          title={t("remoteSurfacesTab.tailnetSectionTitle")}
          actions={<Button size="sm" variant="outline" onClick={() => void refresh()}>{t("tailnetAccessTab.refresh")}</Button>}
        >
          <p className="text-sm text-muted-foreground">{t("tailnetAccessTab.disabled")}</p>
        </SettingsSection>
      ) : null}

      {!loading && !disabled && snapshot ? (
        <>
          <p className="rounded-md border border-border bg-card/(--opacity-half) px-3 py-2 text-xs text-muted-foreground">
            {t("tailnetAccessTab.pairingIsNotAccess")}
          </p>

          <SettingsSection
            title={t("tailnetAccessTab.inviteTitle")}
            description={t("tailnetAccessTab.inviteDescription")}
          >
            <div className="flex flex-wrap items-end gap-3">
              <label className="grid gap-1 text-xs font-medium">
                <span>{t("tailnetAccessTab.inviteDurationLabel")}</span>
                <NativeSelect
                  size="sm"
                  value={invitationDuration}
                  disabled={busy !== null}
                  onChange={(event) => setInvitationDuration(event.target.value as TailnetInvitationDurationPreset)}
                  data-testid="tailnet-access-invitation-duration"
                >
                  {TAILNET_INVITATION_DURATION_PRESETS.map((duration) => (
                    <NativeSelectOption key={duration} value={duration}>{durationLabel(duration, t)}</NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => void createInvitation()}
                data-testid="tailnet-access-create-invitation"
              >
                {t("tailnetAccessTab.createInvitation")}
              </Button>
            </div>

            {issuedInvitation ? (
              <div className="mt-3 rounded-md border border-primary/(--opacity-medium) bg-primary/(--opacity-subtle) p-3" data-testid="tailnet-access-issued-invitation">
                <p className="text-xs font-medium">{t("tailnetAccessTab.createdInvitationTitle")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("tailnetAccessTab.createdInvitationDescription")}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="max-w-full overflow-x-auto rounded bg-background px-2 py-1 font-mono text-xs" data-testid="tailnet-access-invitation-code">
                    {issuedInvitation.code}
                  </code>
                  <Button size="sm" variant="outline" onClick={copyInvitation} data-testid="tailnet-access-copy-invitation">
                    {copied ? t("tailnetAccessTab.copied") : t("tailnetAccessTab.copy")}
                  </Button>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {t("tailnetAccessTab.expiresAt", { time: formatMediumDateTime(issuedInvitation.expiresAt) })}
                </p>
              </div>
            ) : null}
          </SettingsSection>

          <SettingsSection
            title={t("tailnetAccessTab.pairingsTitle")}
            description={t("tailnetAccessTab.pairingsDescription")}
            actions={<Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void refresh()}>{t("tailnetAccessTab.refresh")}</Button>}
          >
            {snapshot.pairings.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("tailnetAccessTab.noPairings")}</p>
            ) : (
              <ul className="space-y-2" data-testid="tailnet-access-pairings">
                {snapshot.pairings.map((pairing) => (
                  <li key={pairing.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card/(--opacity-half) px-3 py-2">
                    <div className="min-w-0">
                      <p className="font-mono text-xs">Tailnet · {pairing.actorFingerprint}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {pairing.state === "pending" ? t("tailnetAccessTab.pending") : t("tailnetAccessTab.active")}
                        {pairing.expiresAt === null ? "" : ` · ${t("tailnetAccessTab.expiresAt", { time: formatMediumDateTime(pairing.expiresAt) })}`}
                      </p>
                    </div>
                    {pairing.state === "pending" ? (
                      <Button size="sm" disabled={busy !== null} onClick={() => void runMutation(`activate:${pairing.id}`, () => api.tailnetSharing.activatePairing(pairing.id))}>
                        {t("tailnetAccessTab.activate")}
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void runMutation(`revoke-pairing:${pairing.id}`, () => api.tailnetSharing.revokePairing(pairing.id))}>
                        {t("tailnetAccessTab.revokePairing")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SettingsSection>

          <SettingsSection
            title={t("tailnetAccessTab.shareTitle")}
            description={t("tailnetAccessTab.shareDescription")}
          >
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <label className="grid gap-1 text-xs font-medium">
                <span>{t("tailnetAccessTab.sharePermissionLabel")}</span>
                <NativeSelect
                  size="sm"
                  value={sharePermission}
                  disabled={busy !== null}
                  onChange={(event) => setSharePermission(event.target.value as TailnetSharePermission)}
                  data-testid="tailnet-access-share-permission"
                >
                  <NativeSelectOption value="observe">{t("tailnetAccessTab.observe")}</NativeSelectOption>
                  <NativeSelectOption value="control">{t("tailnetAccessTab.control")}</NativeSelectOption>
                </NativeSelect>
              </label>
              <label className="grid gap-1 text-xs font-medium">
                <span>{t("tailnetAccessTab.shareDurationLabel")}</span>
                <NativeSelect
                  size="sm"
                  value={shareDuration}
                  disabled={busy !== null}
                  onChange={(event) => setShareDuration(event.target.value as TailnetShareDurationPreset)}
                  data-testid="tailnet-access-share-duration"
                >
                  {TAILNET_SHARE_DURATION_PRESETS.map((duration) => (
                    <NativeSelectOption key={duration} value={duration}>{durationLabel(duration, t)}</NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
            </div>

            {activePairings.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("tailnetAccessTab.noActivePairing")}</p>
            ) : (
              <ul className="space-y-2" data-testid="tailnet-access-active-pairings">
                {activePairings.map((pairing) => (
                  <li key={pairing.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card/(--opacity-half) px-3 py-2">
                    <code className="font-mono text-xs">Tailnet · {pairing.actorFingerprint}</code>
                    <Button size="sm" disabled={busy !== null} onClick={() => createShare(pairing.id)}>
                      {t("tailnetAccessTab.createShare")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 border-t border-border pt-3">
              {snapshot.shares.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("tailnetAccessTab.noShares")}</p>
              ) : (
                <ul className="space-y-2" data-testid="tailnet-access-shares">
                  {snapshot.shares.map((share) => (
                    <li key={share.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card/(--opacity-half) px-3 py-2">
                      <div className="min-w-0">
                        <p className="font-mono text-xs">Tailnet · {share.actorFingerprint}</p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {share.permission === "observe" ? t("tailnetAccessTab.observe") : t("tailnetAccessTab.control")}
                          {` · ${t("tailnetAccessTab.expiresAt", { time: formatMediumDateTime(share.expiresAt) })}`}
                        </p>
                      </div>
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void runMutation(`revoke-share:${share.id}`, () => api.tailnetSharing.revokeShare(share.id))}>
                        {t("tailnetAccessTab.revokeShare")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </SettingsSection>
        </>
      ) : null}
    </div>
  );
}
