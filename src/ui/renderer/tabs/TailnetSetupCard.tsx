/**
 * Guided setup for Tailnet access.
 *
 * The full listener form asks seven questions, and six of them have exactly one
 * answer a first-time owner can give — which is why the surface that shipped
 * with it read as a configuration file with switches rather than as a way to
 * reach your own conversation from a phone. `guidedSetup` is that whole
 * configuration as one host-side operation, so once this desktop's Tailscale
 * answers "ready" there is nothing left to ask: the section reads as one
 * collapsed card in the same idiom as a model provider row — a state, the facts
 * the probe reported, and one button that connects.
 *
 * It is a separate component from {@link TailnetObserverSection} rather than a
 * mode inside it: that form stays exactly what it is, the thing a person who
 * wants to name every value reaches for, and this one owns the flow — including
 * the hand-off to the invitation control that lives in the surrounding tab.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { SettingsSection } from "../components/PageShell.js";
import type { TailnetObserverSnapshot } from "../../../shared/tailnet-observer-config.js";
import { useCopyFlash } from "../hooks/use-copy-flash.js";
import {
  TailnetObserverSection,
  tailnetEnvironmentText,
  tailnetObserverErrorText,
} from "./TailnetObserverSection.js";
import type { LvisApi } from "../types.js";

export interface TailnetSetupCardProps {
  api: Pick<LvisApi, "tailnetObserver">;
  /**
   * Move the reader to the invitation control in the surrounding tab.
   *
   * The finished panel needs an invitation code to be reachable, and the
   * control that mints one already exists a screen below. Drawing a second one
   * here would put the same one-use secret in two places.
   */
  onCreateInvitation: () => void;
}

/**
 * The section's one action, in the provider-row shape.
 *
 * There is no separate re-check control: this button re-reads the environment
 * and then either connects or leaves the sentence that says why it could not,
 * so the spinner it shows is the probe and the command both.
 */
function ConnectButton({
  busy,
  label,
  onConnect,
  t,
  testId = "tailnet-setup-connect",
}: {
  busy: boolean;
  label: string;
  onConnect: () => Promise<void>;
  t: (key: string) => string;
  testId?: string;
}) {
  return (
    <Button
      size="sm"
      className="gap-1.5"
      disabled={busy}
      onClick={() => void onConnect()}
      data-testid={testId}
    >
      {busy ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
      {busy ? t("tailnetSetup.connecting") : label}
    </Button>
  );
}

/** Setup is finished when the listener the file asked for is actually bound. */
function isConfigured(snapshot: TailnetObserverSnapshot | null): boolean {
  return snapshot !== null && snapshot.effective.enabled && snapshot.listeningPort !== null;
}

export function TailnetSetupCard({ api, onCreateInvitation }: TailnetSetupCardProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<TailnetObserverSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tailscale's own words for a failed Serve. The sentence for that code says
  // its output is below, so losing it leaves a promise with nothing under it —
  // and the certificate case is the one nobody can act on without it.
  const [errorOutput, setErrorOutput] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const [chosenPort, setChosenPort] = useState<number | null>(null);
  const [webOrigin, setWebOrigin] = useState<string | null>(null);
  const [admissionBusy, setAdmissionBusy] = useState(false);
  // Kept apart from `error`, which belongs to the connect button: a refused
  // admission must not replace the sentence explaining why Serve failed.
  const [admissionError, setAdmissionError] = useState<string | null>(null);
  const { copied, copy: copyToClipboard } = useCopyFlash();
  // Whether the reader has been shown a screen yet. The first snapshot decides
  // between the setup card and the status card; every later one must not yank
  // the reader out of what they are looking at.
  const settledRef = useRef(false);

  const readSnapshot = useCallback(async (): Promise<TailnetObserverSnapshot | null> => {
    const result = await api.tailnetObserver.snapshot();
    if (result.ok) {
      setSnapshot(result.snapshot);
      setUnavailable(false);
    } else {
      setSnapshot(null);
      setUnavailable(true);
      setError(result.error);
    }
    setLoading(false);
    return result.ok ? result.snapshot : null;
  }, [api]);

  useEffect(() => {
    void (async () => {
      const next = await readSnapshot();
      if (settledRef.current) return;
      settledRef.current = true;
      setShowSetup(!isConfigured(next));
    })();
  }, [readSnapshot]);

  const environmentReady = snapshot?.environment.state === "ready";

  // The press is the check. A separate "check again" control asked the reader
  // to verify an environment they cannot change from here, and made a stale
  // "ready" read at mount the thing guided setup ran on; re-probing inside the
  // press is what removes both.
  const connect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setErrorOutput(null);
    const probed = await readSnapshot();
    if (probed === null || probed.environment.state !== "ready") {
      // The re-read already put the sentence that says why on screen, and it
      // says which way Tailscale is unusable — an error code on top of it would
      // only repeat that in worse words.
      setBusy(false);
      return;
    }
    const result = await api.tailnetObserver.guidedSetup();
    if (result.ok) {
      setSnapshot(result.snapshot);
      setChosenPort(result.port);
      setWebOrigin(result.webOrigin);
      setCompleted(true);
      setShowSetup(true);
    } else {
      setError(result.error);
      setErrorOutput(result.output);
      // Tailscale stopped being usable between this press's own probe and the
      // command, so re-reading is what turns the card back into the sentence
      // that says how.
      if (result.error === "tailnet-guided-setup-not-ready") await readSnapshot();
    }
    setBusy(false);
  }, [api, busy, readSnapshot]);

  // Two presses, one operation: which account is admitted is the host's answer,
  // so the renderer sends only the direction and re-reads what the host decided.
  const setOwnDeviceAdmission = useCallback(async (enabled: boolean) => {
    if (admissionBusy) return;
    setAdmissionBusy(true);
    setAdmissionError(null);
    const result = await api.tailnetObserver.setOwnDeviceAdmission(enabled);
    if (!result.ok) setAdmissionError(result.error);
    await readSnapshot();
    setAdmissionBusy(false);
  }, [admissionBusy, api, readSnapshot]);

  // The manual form is both the escape hatch beside the connect button and the
  // one on the status card. Only the first of those can finish setup, so a save
  // made from the status card refreshes the facts and leaves the form open.
  const finishFromManualForm = useCallback(async () => {
    const next = await readSnapshot();
    if (!showSetup || !isConfigured(next)) return;
    setShowSetup(false);
    setShowManualForm(false);
  }, [readSnapshot, showSetup]);

  const closeSetup = useCallback(() => {
    setShowSetup(false);
    setCompleted(false);
    setShowManualForm(false);
    setError(null);
    setErrorOutput(null);
    void readSnapshot();
  }, [readSnapshot]);

  if (loading) {
    return (
      <SettingsSection
        data-settings-section="remote-tailnet-observer"
        title={t("tailnetSetup.sectionTitle")}
      >
        <p className="text-sm text-muted-foreground" data-testid="tailnet-setup-loading">
          {t("tailnetObserver.loading")}
        </p>
      </SettingsSection>
    );
  }

  if (unavailable || snapshot === null) {
    return (
      <SettingsSection
        data-settings-section="remote-tailnet-observer"
        title={t("tailnetSetup.sectionTitle")}
      >
        <p className="text-sm text-destructive" data-testid="tailnet-setup-error">
          {error === null
            ? t("tailnetObserver.errorUnavailable")
            : tailnetObserverErrorText(error, t)}
        </p>
        {/* The same one button, because a settings read that failed once may
            succeed on the next press — and there is nothing else here to press. */}
        <div className="mt-3">
          <ConnectButton busy={busy} label={t("tailnetSetup.connect")} onConnect={connect} t={t} />
        </div>
      </SettingsSection>
    );
  }

  const derivedOrigin = webOrigin ?? snapshot.derivedWebOrigin;
  const listeningPort = snapshot.listeningPort;
  const serveOn = snapshot.environment.serveConfigured
    && snapshot.environment.serveTargetPort === listeningPort;

  const failure = error === null ? null : (
    <>
      <p className="text-sm text-destructive" data-testid="tailnet-setup-error">
        {tailnetObserverErrorText(error, t)}
      </p>
      {errorOutput === null ? null : (
        <pre
          className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive"
          data-testid="tailnet-setup-error-output"
        >
          {errorOutput}
        </pre>
      )}
    </>
  );

  /**
   * The own-device control, in its two states.
   *
   * A button rather than a switch, because the way back has to be visible: the
   * on state says what is true and puts 해제 next to it, so nobody has to guess
   * that pressing the same thing again would take the access away.
   *
   * It is drawn only where pairing exists at all — without paired sharing there
   * is no pairing to waive an approval for, and a control that cannot act is
   * worse than an absent one.
   */
  const ownDeviceAdmissionControl = snapshot.effective.pairedSharingEnabled ? (
    <div className="min-w-0 space-y-1" data-testid="tailnet-own-device-admission">
      <div className="flex flex-wrap items-center gap-2">
        {snapshot.ownDeviceAdmission ? (
          <>
            <Badge variant="secondary" data-testid="tailnet-own-device-admission-state">
              {t("tailnetSetup.ownDeviceAdmissionOn")}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              disabled={admissionBusy}
              onClick={() => void setOwnDeviceAdmission(false)}
              data-testid="tailnet-own-device-admission-release"
            >
              {t("tailnetSetup.ownDeviceAdmissionRelease")}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={admissionBusy}
            onClick={() => void setOwnDeviceAdmission(true)}
            data-testid="tailnet-own-device-admission-allow"
          >
            {t("tailnetSetup.ownDeviceAdmissionAllow")}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {snapshot.ownDeviceAdmission
          ? t("tailnetSetup.ownDeviceAdmissionOnDescription")
          : t("tailnetSetup.ownDeviceAdmissionOffDescription")}
      </p>
      {admissionError === null ? null : (
        <p className="text-sm text-destructive" data-testid="tailnet-own-device-admission-error">
          {tailnetObserverErrorText(admissionError, t)}
        </p>
      )}
    </div>
  ) : null;

  const manualToggle = (
    <Button
      size="sm"
      variant="ghost"
      aria-expanded={showManualForm}
      onClick={() => setShowManualForm((shown) => !shown)}
      data-testid="tailnet-setup-manual-toggle"
    >
      {showManualForm ? t("tailnetSetup.manualHide") : t("tailnetSetup.manualShow")}
    </Button>
  );

  const manualForm = showManualForm ? (
    <div data-testid="tailnet-setup-manual-form">
      <TailnetObserverSection api={api} onHostStateChanged={finishFromManualForm} />
    </div>
  ) : null;

  return (
    <SettingsSection
      data-settings-section="remote-tailnet-observer"
      title={t("tailnetSetup.sectionTitle")}
      description={t("tailnetSetup.sectionDescription")}
    >
      {!showSetup ? (
        <div className="min-w-0 space-y-3" data-testid="tailnet-setup-status">
          <p className="text-sm font-medium">{t("tailnetSetup.statusTitle")}</p>
          <p
            className="text-sm break-words text-muted-foreground"
            data-testid="tailnet-setup-status-environment"
          >
            {tailnetEnvironmentText(snapshot.environment, t)}
          </p>
          {derivedOrigin === null ? null : (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {t("tailnetSetup.webUrlLabel")}
              </span>
              <code
                className="max-w-full overflow-x-auto rounded bg-background px-2 py-1 font-mono text-xs"
                data-testid="tailnet-setup-status-url"
              >
                {derivedOrigin}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyToClipboard(derivedOrigin)}
                data-testid="tailnet-setup-status-copy"
              >
                {copied ? t("tailnetObserver.copied") : t("tailnetObserver.copy")}
              </Button>
            </div>
          )}
          <p className="text-sm text-muted-foreground" data-testid="tailnet-setup-status-port">
            {`${t("tailnetObserver.portLabel")}: ${listeningPort ?? chosenPort ?? ""}`}
            {/* A port nothing in the file names is one this desktop chose, and
                saying so is what keeps "why is it not 46173" answerable. */}
            {snapshot.provenance.port === "unset" ? ` (${t("tailnetSetup.statusPortAuto")})` : ""}
          </p>
          <p className="text-sm text-muted-foreground" data-testid="tailnet-setup-status-serve">
            {serveOn ? t("tailnetSetup.statusServeOn") : t("tailnetSetup.statusServeOff")}
          </p>
          {ownDeviceAdmissionControl}
          <div className="flex flex-wrap items-center gap-2">
            <ConnectButton
              busy={busy}
              label={t("tailnetSetup.reconfigure")}
              onConnect={connect}
              t={t}
              testId="tailnet-setup-reconfigure"
            />
            {manualToggle}
          </div>
          {failure}
          {manualForm}
        </div>
      ) : completed ? (
        <div className="min-w-0 space-y-3" data-testid="tailnet-setup-done">
          <p className="text-sm font-medium">{t("tailnetSetup.doneTitle")}</p>
          {derivedOrigin === null ? null : (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {t("tailnetSetup.webUrlLabel")}
              </span>
              <code
                className="max-w-full overflow-x-auto rounded bg-background px-2 py-1 font-mono text-xs"
                data-testid="tailnet-setup-done-url"
              >
                {derivedOrigin}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyToClipboard(derivedOrigin)}
                data-testid="tailnet-setup-done-copy"
              >
                {copied ? t("tailnetObserver.copied") : t("tailnetObserver.copy")}
              </Button>
            </div>
          )}
          <p className="text-sm text-muted-foreground">{t("tailnetSetup.doneOwnDevice")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onCreateInvitation}
              data-testid="tailnet-setup-create-invitation"
            >
              {t("tailnetSetup.createInvitation")}
            </Button>
            <Button size="sm" onClick={closeSetup} data-testid="tailnet-setup-close">
              {t("tailnetSetup.close")}
            </Button>
          </div>
        </div>
      ) : environmentReady ? (
        <div className="min-w-0 space-y-3">
          {/* The provider-row idiom, because this is the same kind of thing: a
              connection whose every setting the host already decided. State,
              the facts the probe reported, one button that connects. */}
          <div
            className="min-w-0 space-y-3 rounded-md border border-border bg-card p-3"
            data-testid="tailnet-setup-ready"
          >
            <div className="min-w-0 space-y-1">
              <Badge variant="secondary" data-testid="tailnet-setup-ready-state">
                {t("tailnetSetup.readyState")}
              </Badge>
              {/* The node name is one unbreakable token, and at the narrow pane
                  floor it runs past the card's edge without this. */}
              <p
                className="text-sm break-words text-muted-foreground"
                data-testid="tailnet-setup-ready-facts"
              >
                {tailnetEnvironmentText(snapshot.environment, t)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("tailnetSetup.connectDescription")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ConnectButton busy={busy} label={t("tailnetSetup.connect")} onConnect={connect} t={t} />
              {manualToggle}
            </div>
          </div>
          {failure}
          {manualForm}
        </div>
      ) : (
        <div className="min-w-0 space-y-3" data-testid="tailnet-setup-not-ready">
          <div
            className="rounded-md border border-border bg-card/(--opacity-half) px-3 py-2 text-sm break-words text-muted-foreground"
            data-testid="tailnet-setup-environment"
          >
            {tailnetEnvironmentText(snapshot.environment, t)}
          </div>
          {snapshot.environment.detail === null ? null : (
            <pre
              className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card/(--opacity-half) px-3 py-2 text-xs text-muted-foreground"
              data-testid="tailnet-setup-environment-detail"
            >
              {snapshot.environment.detail}
            </pre>
          )}
          {/* The same button as the ready card, and the same press: it re-reads
              this desktop's Tailscale and goes on to connect the moment that
              read comes back usable. No failure sentence is drawn beside it —
              the box above already says which way Tailscale is not ready. */}
          <ConnectButton busy={busy} label={t("tailnetSetup.connect")} onConnect={connect} t={t} />
        </div>
      )}
    </SettingsSection>
  );
}
