import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import {
  NativeSelect,
  NativeSelectOption,
} from "../../../components/ui/native-select.js";
import {
  TELEGRAM_APPROVAL_DURATION_PRESETS,
  type TelegramApprovalDurationPreset,
  type TelegramConnectionMutationResult,
  type TelegramConnectionSnapshot,
  type TelegramCreatedPairingCode,
} from "../../../shared/telegram-connection.js";
import { SettingsSection } from "../components/PageShell.js";
import { formatIpcError } from "../format-ipc-error.js";
import { formatMediumDateTime } from "../../../shared/format-time.js";
import { AwayAuthorityContent } from "./AwayAuthorityContent.js";
import type { LvisApi } from "../types.js";

export interface TelegramConnectionContentProps {
  api: LvisApi;
  /**
   * The tile the away-authority grant would bind to — the focused conversation.
   * Threaded from the window because settings has no conversation of its own,
   * and main refuses a grant that names no tile.
   */
  chatGroupId: string;
}

type Feedback = { readonly tone: "error" | "success"; readonly text: string } | null;

function durationLabel(
  value: TelegramApprovalDurationPreset,
  t: (key: string) => string,
): string {
  switch (value) {
    case "1h": return t("telegramConnection.duration1h");
    case "8h": return t("telegramConnection.duration8h");
    case "24h": return t("telegramConnection.duration24h");
  }
}

/**
 * The share is durable, so `active` is one state with two readings: replies can
 * flow right now, or the shared conversation is closed and they resume when it
 * is opened again. Main decides the state; only this distinction is read off
 * the approval, and only for the label.
 */
function stateLabel(
  snapshot: TelegramConnectionSnapshot,
  t: (key: string) => string,
): string {
  switch (snapshot.state) {
    case "unsupported": return t("telegramConnection.stateUnsupported");
    case "disconnected": return t("telegramConnection.stateDisconnected");
    case "connected-unpaired": return t("telegramConnection.stateConnectedUnpaired");
    case "pairing-unrecognized": return t("telegramConnection.statePairingUnrecognized");
    case "pairing-pending": return t("telegramConnection.statePairingPending");
    case "paired-unapproved": return t("telegramConnection.statePairedUnapproved");
    case "active":
      return sharedConversationIsOpen(snapshot)
        ? t("telegramConnection.stateActive")
        : t("telegramConnection.stateSharedConversationNotOpen");
    case "shared-conversation-missing":
      return t("telegramConnection.stateSharedConversationMissing");
    case "paused-by-owner": return t("telegramConnection.statePausedByOwner");
    case "error": return t("telegramConnection.stateError");
  }
}

/** False only while a share exists and its conversation is not the open one. */
function sharedConversationIsOpen(snapshot: TelegramConnectionSnapshot): boolean {
  return snapshot.approval === null || snapshot.approval.matchesCurrentConversation;
}

/**
 * Owner controls for the Telegram private-DM surface.
 *
 * The renderer holds no durable state of its own: `state` is derived by main
 * and read back after every mutation. The only value that lives here is the
 * freshly minted pairing code, which main returns exactly once and which no
 * snapshot can reproduce.
 */
export function TelegramConnectionContent({ api, chatGroupId }: TelegramConnectionContentProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<TelegramConnectionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [duration, setDuration] = useState<TelegramApprovalDurationPreset>("8h");
  const [issuedCode, setIssuedCode] = useState<TelegramCreatedPairingCode | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.telegramConnection.snapshot();
      if (result.ok) {
        setSnapshot(result.snapshot);
        return;
      }
      setSnapshot(null);
      setFeedback({ tone: "error", text: formatIpcError(result.error, undefined) });
    } catch {
      setSnapshot(null);
      setFeedback({ tone: "error", text: t("telegramConnection.operationFailed") });
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    void refresh();
    return api.telegramConnection.onChanged(() => {
      void refresh();
    });
  }, [api, refresh]);

  const run = useCallback(async (
    operation: () => Promise<TelegramConnectionMutationResult>,
  ) => {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await operation();
      if (!result.ok) {
        setFeedback({ tone: "error", text: formatIpcError(result.error, undefined) });
        return false;
      }
      setFeedback({ tone: "success", text: t("telegramConnection.operationSucceeded") });
      await refresh();
      return true;
    } catch {
      setFeedback({ tone: "error", text: t("telegramConnection.operationFailed") });
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh, t]);

  const connect = useCallback(async () => {
    // The token never re-enters component state after this call, and there is
    // no channel that could read it back.
    const token = botToken;
    setBotToken("");
    const ok = await run(() => api.telegramConnection.connect(token));
    if (ok) setConnecting(false);
  }, [api, botToken, run]);

  const createPairingCode = useCallback(async () => {
    setBusy(true);
    setFeedback(null);
    setCopied(false);
    try {
      const result = await api.telegramConnection.createPairingCode();
      if (!result.ok) {
        setFeedback({ tone: "error", text: formatIpcError(result.error, undefined) });
        return;
      }
      // Sole renderer home of the raw code. No snapshot or change event can
      // recreate it after this component unmounts.
      setIssuedCode(result.pairingCode);
      await refresh();
    } catch {
      setFeedback({ tone: "error", text: t("telegramConnection.operationFailed") });
    } finally {
      setBusy(false);
    }
  }, [api, refresh, t]);

  const copyCode = useCallback(() => {
    if (!issuedCode || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(issuedCode.code).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }, [issuedCode]);

  const state = snapshot?.state ?? null;
  const readOnly = state === "unsupported";
  // A pairing this machine can no longer recognise is repaired the same way a
  // missing one is: mint a code and send it. Same affordance, different reason,
  // which the body text below supplies.
  const canPair = state === "connected-unpaired"
    || state === "pairing-unrecognized"
    || state === "pairing-pending";
  // Sharing the conversation now open is offered when nothing is shared, when
  // what is shared is some other conversation, and when what is shared no
  // longer exists — that last one is the only repair, so withholding the button
  // there would name a problem and offer no way out of it.
  const canApprove = state === "paired-unapproved"
    || state === "shared-conversation-missing"
    || (snapshot !== null && state === "active" && !sharedConversationIsOpen(snapshot));
  const connected = useMemo(
    () => state !== null && !readOnly && state !== "disconnected",
    [readOnly, state],
  );

  useEffect(() => {
    // A code that has been redeemed or replaced must stop being displayed.
    if (snapshot !== null && snapshot.pendingCode === null) setIssuedCode(null);
  }, [snapshot]);

  return (
    <SettingsSection
      title={t("telegramConnection.sectionTitle")}
      description={t("telegramConnection.sectionDescription")}
      actions={
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void refresh()}
          data-testid="telegram-connection-refresh"
        >
          {t("telegramConnection.refresh")}
        </Button>
      }
    >
      <div className="space-y-3" data-testid="telegram-connection-content">
        {feedback ? (
          <p
            role={feedback.tone === "error" ? "alert" : "status"}
            className={feedback.tone === "error"
              ? "rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive"
              : "rounded-md border border-primary/(--opacity-medium) bg-primary/(--opacity-subtle) px-3 py-2 text-xs text-foreground"}
            data-testid="telegram-connection-feedback"
          >
            {feedback.text}
          </p>
        ) : null}

        {loading ? (
          <p className="text-sm text-muted-foreground" data-testid="telegram-connection-loading">
            {t("telegramConnection.loading")}
          </p>
        ) : null}

        {!loading && snapshot ? (
          <>
            <p className="text-sm font-medium" data-testid="telegram-connection-state">
              {stateLabel(snapshot, t)}
              {snapshot.botUsername === null ? "" : ` · ${t("telegramConnection.botLabel")} @${snapshot.botUsername}`}
            </p>

            {snapshot.lastErrorCode !== null ? (
              <p className="text-xs text-destructive" data-testid="telegram-connection-last-error">
                {formatIpcError(snapshot.lastErrorCode, undefined)}
              </p>
            ) : null}

            {snapshot.state === "unsupported" ? (
              <p className="text-xs text-muted-foreground">{t("telegramConnection.unsupportedBody")}</p>
            ) : null}

            {snapshot.state === "pairing-unrecognized" ? (
              <p className="text-xs text-destructive" data-testid="telegram-connection-pairing-unrecognized">
                {t("telegramConnection.pairingUnrecognizedBody")}
              </p>
            ) : null}

            {snapshot.state === "shared-conversation-missing" ? (
              <p className="text-xs text-destructive" data-testid="telegram-connection-shared-conversation-missing">
                {t("telegramConnection.sharedConversationMissingBody")}
              </p>
            ) : null}

            {/*
              Suppressed while the conversation is gone. Both readings come out
              of the same "not on screen" observation, but this one tells the
              owner the share is waiting for them to reopen it — advice that
              sends them looking for something that no longer exists.
            */}
            {snapshot.state !== "shared-conversation-missing" && !sharedConversationIsOpen(snapshot) ? (
              <p className="text-xs text-muted-foreground" data-testid="telegram-connection-shared-conversation-closed">
                {t("telegramConnection.sharedConversationNotOpenBody")}
              </p>
            ) : null}

            {snapshot.state === "disconnected" && !connecting ? (
              <Button size="sm" disabled={busy} onClick={() => setConnecting(true)} data-testid="telegram-connection-connect">
                {t("telegramConnection.connect")}
              </Button>
            ) : null}

            {snapshot.state === "disconnected" && connecting ? (
              <div className="rounded-md border border-border bg-card/(--opacity-half) p-3" data-testid="telegram-connection-connect-form">
                <p className="text-xs font-medium">{t("telegramConnection.connectDialogTitle")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("telegramConnection.connectDialogBody")}</p>
                <label className="mt-2 grid gap-1 text-xs font-medium">
                  <span>{t("telegramConnection.botTokenLabel")}</span>
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={botToken}
                    placeholder={t("telegramConnection.botTokenPlaceholder")}
                    onChange={(event) => setBotToken(event.target.value)}
                    data-testid="telegram-connection-bot-token"
                  />
                </label>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {t("telegramConnection.continuousConnectionNotice")}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t("telegramConnection.backlogNotice")}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy || botToken.length === 0} onClick={() => void connect()} data-testid="telegram-connection-submit-token">
                    {t("telegramConnection.connect")}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => { setConnecting(false); setBotToken(""); }}>
                    {t("telegramConnection.cancel")}
                  </Button>
                </div>
              </div>
            ) : null}

            {canPair && !readOnly ? (
              <div className="space-y-2">
                <p className="text-[11px] text-muted-foreground">{t("telegramConnection.pairingIsNotAccess")}</p>
                <Button size="sm" disabled={busy} onClick={() => void createPairingCode()} data-testid="telegram-connection-create-pairing-code">
                  {snapshot.pendingCode === null
                    ? t("telegramConnection.createPairingCode")
                    : t("telegramConnection.regeneratePairingCode")}
                </Button>
              </div>
            ) : null}

            {issuedCode ? (
              <div className="rounded-md border border-primary/(--opacity-medium) bg-primary/(--opacity-subtle) p-3" data-testid="telegram-connection-issued-code">
                <p className="text-xs font-medium">{t("telegramConnection.pairingCodeTitle")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("telegramConnection.pairingCodeBody")}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="max-w-full overflow-x-auto rounded bg-background px-2 py-1 font-mono text-xs" data-testid="telegram-connection-pairing-code">
                    {issuedCode.code}
                  </code>
                  <Button size="sm" variant="outline" onClick={copyCode} data-testid="telegram-connection-copy-code">
                    {copied ? t("telegramConnection.copied") : t("telegramConnection.copy")}
                  </Button>
                  <a
                    className="text-xs underline"
                    href={`https://t.me/${issuedCode.botUsername}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("telegramConnection.openInTelegram")}
                  </a>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {t("telegramConnection.expiresAt", { time: formatMediumDateTime(issuedCode.expiresAt) })}
                </p>
              </div>
            ) : null}

            {snapshot.pendingCode !== null ? (
              <p className="text-[11px] text-muted-foreground" data-testid="telegram-connection-pending-code">
                {t("telegramConnection.attemptsRemaining", { count: snapshot.pendingCode.attemptsRemaining })}
              </p>
            ) : null}

            {snapshot.pairing !== null ? (
              <p className="font-mono text-xs" data-testid="telegram-connection-pairing">
                {t("telegramConnection.pairedAccount")} · {snapshot.pairing.accountFingerprint}
              </p>
            ) : null}

            {canApprove && !readOnly ? (
              <div className="flex flex-wrap items-end gap-3">
                <label className="grid gap-1 text-xs font-medium">
                  <span>{t("telegramConnection.approvalDurationLabel")}</span>
                  <NativeSelect
                    size="sm"
                    value={duration}
                    disabled={busy}
                    onChange={(event) => setDuration(event.target.value as TelegramApprovalDurationPreset)}
                    data-testid="telegram-connection-approval-duration"
                  >
                    {TELEGRAM_APPROVAL_DURATION_PRESETS.map((preset) => (
                      <NativeSelectOption key={preset} value={preset}>{durationLabel(preset, t)}</NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => api.telegramConnection.approveCurrentConversation(duration))}
                  data-testid="telegram-connection-approve"
                >
                  {t("telegramConnection.approveCurrentConversation")}
                </Button>
              </div>
            ) : null}

            {snapshot.approval !== null ? (
              <p className="text-[11px] text-muted-foreground" data-testid="telegram-connection-approval">
                {t("telegramConnection.expiresAt", { time: formatMediumDateTime(snapshot.approval.expiresAt) })}
              </p>
            ) : null}

            {snapshot.state === "active" && sharedConversationIsOpen(snapshot) ? (
              <p className="text-[11px] text-muted-foreground">{t("telegramConnection.sendFirstMessage")}</p>
            ) : null}

            {/*
              Arming lives here rather than in its own tab because it is only
              meaningful once something is shared: the answerer refuses every
              turn that is not a paired-platform turn, so a control for it on a
              disconnected desktop would offer an authority over nothing.
            */}
            {snapshot.approval !== null && !readOnly ? (
              <AwayAuthorityContent
                api={api}
                chatGroupId={chatGroupId}
                shareIsLive={snapshot.state === "active" && sharedConversationIsOpen(snapshot)}
              />
            ) : null}

            {connected ? (
              <>
                <p className="text-[11px] text-muted-foreground">{t("telegramConnection.pauseNotice")}</p>
                <div className="flex flex-wrap gap-2">
                  {snapshot.state === "paused-by-owner" ? (
                    <Button size="sm" disabled={busy} onClick={() => void run(() => api.telegramConnection.resume())} data-testid="telegram-connection-resume">
                      {t("telegramConnection.resume")}
                    </Button>
                  ) : snapshot.state === "error" ? (
                    /*
                      The one repair for a connection that is down but still
                      configured. It re-reads the token, re-verifies the bot and
                      re-activates, and a successful activation clears the
                      recorded error — so it is the non-destructive way back
                      from a failure that kept the pairing, which the only other
                      control here (Disconnect) would spend. Pausing a bridge
                      that is already not receiving would say nothing.
                    */
                    <Button size="sm" disabled={busy} onClick={() => void run(() => api.telegramConnection.resume())} data-testid="telegram-connection-retry">
                      {t("telegramConnection.retry")}
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.telegramConnection.pause())} data-testid="telegram-connection-pause">
                      {t("telegramConnection.pause")}
                    </Button>
                  )}
                  {snapshot.approval !== null ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void run(() => api.telegramConnection.revokeApproval(snapshot.approval!.id))}
                      data-testid="telegram-connection-revoke-approval"
                    >
                      {t("telegramConnection.revokeApproval")}
                    </Button>
                  ) : null}
                  {snapshot.pairing !== null ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void run(() => api.telegramConnection.revokePairing(snapshot.pairing!.id))}
                      data-testid="telegram-connection-unpair"
                    >
                      {t("telegramConnection.unpair")}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.telegramConnection.disconnect())} data-testid="telegram-connection-disconnect">
                    {t("telegramConnection.disconnect")}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">{t("telegramConnection.disconnectNotice")}</p>
              </>
            ) : null}

            <p className="rounded-md border border-border bg-card/(--opacity-half) px-3 py-2 text-[11px] text-muted-foreground">
              {t("telegramConnection.externalRecipientNotice")}
              {" "}
              {t("telegramConnection.approvalStaysLocal")}
            </p>
          </>
        ) : null}
      </div>
    </SettingsSection>
  );
}
