import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { TailnetSetupCard } from "./TailnetSetupCard.js";
import { formatMediumDateTime } from "../../../shared/format-time.js";
import type { LvisApi } from "../types.js";
import { useCopyFlash } from "../hooks/use-copy-flash.js";

export interface TailnetAccessContentProps {
  api: LvisApi;
  /**
   * The owner closed the setup flow after it finished.
   *
   * Reported so an embedding surface can fold this away once the connection is
   * made. A failed connect does not report — the sentence saying why is drawn
   * inside the card, and hiding the card would hide it.
   */
  onCompleted?: () => void;
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

/**
 * Every failure code gets its own sentence.
 *
 * Three sentences used to cover the whole vocabulary, so "no conversation is
 * focused" and "the store could not be written" read identically and neither
 * told anyone what to do next.
 */
function errorText(error: TailnetSharingErrorCode, t: (key: string) => string): string {
  switch (error) {
    case "user-keyboard-required":
      return t("tailnetAccessTab.userGestureRequired");
    case "tailnet-sharing-disabled":
    case "tailnet-sharing-unavailable":
      return t("tailnetAccessTab.disabled");
    case "unauthorized":
    case "unauthorized-frame":
      return t("tailnetAccessTab.errorUnauthorized");
    case "tailnet-sharing-input-invalid":
      return t("tailnetAccessTab.errorInputInvalid");
    case "tailnet-sharing-operation-rejected":
      return t("tailnetAccessTab.errorOperationRejected");
  }

  return t("tailnetAccessTab.operationFailed");
}

/**
 * Local-owner controls for the Tailnet pairing/share boundary. The renderer may
 * choose a fixed-duration preset and opaque pairing id only; main resolves the
 * current conversation and inserts fresh keyboard intent at the preload edge.
 */
export function TailnetAccessContent({ api, onCompleted }: TailnetAccessContentProps) {
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
  /**
   * Pairing whose control share is one confirmation away.
   *
   * Handing someone control of the running conversation is the one action here
   * that cannot be taken back by revoking it later — whatever they drove has
   * already run — so it is asked twice. The question is drawn in the row it
   * belongs to rather than in a window-modal dialog, which would freeze the
   * whole app for a decision about one pairing.
   */
  const [controlShareToConfirm, setControlShareToConfirm] = useState<string | null>(null);
  const { copied, copy: copyToClipboard, reset: resetCopied } = useCopyFlash();
  const invitationButtonRef = useRef<HTMLButtonElement | null>(null);

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

  /**
   * Hand the reader to the invitation control rather than draw a second one.
   *
   * Setup finishes with "now let someone in", and the one-use code that does
   * that already has a home below. Minting it from two places would put the
   * same secret on screen twice, so the last wizard step moves focus here.
   */
  const focusInvitationControl = useCallback(() => {
    const button = invitationButtonRef.current;
    if (button === null) return;
    button.scrollIntoView({ block: "center" });
    button.focus();
  }, []);

  const createShare = useCallback((pairingId: string) => {
    if (sharePermission === "control") {
      setControlShareToConfirm(pairingId);
      return;
    }
    void runMutation(
      `share:${pairingId}`,
      () => api.tailnetSharing.createCurrentConversationShare(pairingId, sharePermission, shareDuration),
    );
  }, [api, runMutation, shareDuration, sharePermission]);

  const confirmControlShare = useCallback((pairingId: string) => {
    setControlShareToConfirm(null);
    void runMutation(
      `share:${pairingId}`,
      () => api.tailnetSharing.createCurrentConversationShare(pairingId, "control", shareDuration),
    );
  }, [api, runMutation, shareDuration]);

  return (
    // The surface carries the deep-link anchor rather than one of its
    // sections: which section renders depends on whether tailnet sharing is
    // available at all, so an anchor on an inner one would land nowhere on
    // exactly the machines a link about it is worth sending.
    <div
      className="space-y-6"
      data-testid="tailnet-access-content"
      data-settings-section="remote-tailnet"
      tabIndex={-1}
    >
      <p className="text-sm text-muted-foreground">{t("tailnetAccessTab.pageDescription")}</p>

      {/* Outside the loading and disabled gates below on purpose: this is the
          control that makes sharing available, so hiding it whenever sharing
          is unavailable is exactly the dead end it exists to remove. */}
      <TailnetSetupCard
        api={api}
        onCreateInvitation={focusInvitationControl}
        {...(onCompleted ? { onSetupClosed: onCompleted } : {})}
      />

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
        // Not the row's own title: this section sits INSIDE the row, and a
        // heading that repeats its container names nothing the reader did not
        // already have.
        <SettingsSection
          title={t("tailnetAccessTab.disabledTitle")}
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
                ref={invitationButtonRef}
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
                  onChange={(event) => {
                    // The pending question was about a control grant; changing
                    // the access level makes it a question about something else.
                    setControlShareToConfirm(null);
                    setSharePermission(event.target.value as TailnetSharePermission);
                  }}
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
                    {controlShareToConfirm === pairing.id ? (
                      <div
                        className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2"
                        data-testid="tailnet-access-control-confirm"
                      >
                        <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                          {t("tailnetAccessTab.controlConfirm")}
                        </p>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() => setControlShareToConfirm(null)}
                          data-testid="tailnet-access-control-confirm-cancel"
                        >
                          {t("tailnetAccessTab.controlConfirmCancel")}
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => confirmControlShare(pairing.id)}
                          data-testid="tailnet-access-control-confirm-accept"
                        >
                          {t("tailnetAccessTab.controlConfirmAccept")}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => createShare(pairing.id)}
                        data-testid="tailnet-access-create-share"
                      >
                        {t("tailnetAccessTab.createShare")}
                      </Button>
                    )}
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
