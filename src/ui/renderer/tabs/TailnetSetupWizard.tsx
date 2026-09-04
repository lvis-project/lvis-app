/**
 * Guided setup for Tailnet access.
 *
 * The full listener form asks seven questions, and six of them have exactly one
 * answer a first-time owner can give — which is why the surface that shipped
 * with it read as a configuration file with switches rather than as a way to
 * reach your own conversation from a phone. This orchestrates the three things
 * that actually have to happen in order (is Tailscale usable, write and start
 * the listener, put it behind Serve) and hands back the address at the end.
 *
 * It is a separate component from {@link TailnetObserverSection} rather than a
 * mode inside it: that form stays exactly what it is, the thing a person who
 * wants to name every value reaches for, and this one owns the flow — including
 * the hand-off to the invitation control that lives in the surrounding tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import { SettingsSection } from "../components/PageShell.js";
import type { TailnetObserverSnapshot } from "../../../shared/tailnet-observer-config.js";
import { useCopyFlash } from "../hooks/use-copy-flash.js";
import {
  TailnetObserverSection,
  tailnetEnvironmentText,
  tailnetObserverErrorText,
} from "./TailnetObserverSection.js";
import type { LvisApi } from "../types.js";

export interface TailnetSetupWizardProps {
  api: Pick<LvisApi, "tailnetObserver">;
  /**
   * Move the reader to the invitation control in the surrounding tab.
   *
   * The last step needs an invitation code to be reachable, and the control
   * that mints one already exists a screen below. Drawing a second one here
   * would put the same one-use secret in two places.
   */
  onCreateInvitation: () => void;
}

/** The ordered stages, per chosen method. Manual replaces "apply" and "done". */
const AUTO_STAGES = ["environment", "mode", "apply", "done"] as const;
const MANUAL_STAGES = ["environment", "mode", "manual"] as const;

type WizardStage = (typeof AUTO_STAGES)[number] | (typeof MANUAL_STAGES)[number];
type SetupMethod = "auto" | "manual";

const STAGE_LABEL_KEY: Readonly<Record<WizardStage, string>> = {
  environment: "tailnetSetup.stepEnvironment",
  mode: "tailnetSetup.stepMode",
  apply: "tailnetSetup.stepApply",
  done: "tailnetSetup.stepDone",
  manual: "tailnetSetup.stepManual",
};

/** Setup is finished when the listener the file asked for is actually bound. */
function isConfigured(snapshot: TailnetObserverSnapshot | null): boolean {
  return snapshot !== null && snapshot.effective.enabled && snapshot.listeningPort !== null;
}

export function TailnetSetupWizard({ api, onCreateInvitation }: TailnetSetupWizardProps) {
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
  const [stage, setStage] = useState<WizardStage>("environment");
  const [method, setMethod] = useState<SetupMethod>("auto");
  const [showWizard, setShowWizard] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const [chosenPort, setChosenPort] = useState<number | null>(null);
  const [webOrigin, setWebOrigin] = useState<string | null>(null);
  const { copied, copy: copyToClipboard } = useCopyFlash();
  // Whether the reader has been shown a screen yet. The first snapshot decides
  // between the wizard and the status card; every later one must not yank the
  // reader out of the step they are standing on.
  const settledRef = useRef(false);

  const readSnapshot = useCallback(async (): Promise<TailnetObserverSnapshot | null> => {
    // An older preload beside a newer renderer degrades to "unavailable" rather
    // than throwing: this is the only place the observer can be turned on, so a
    // throw here would take down the surface it exists to provide.
    const bridge = api.tailnetObserver as typeof api.tailnetObserver | undefined;
    if (bridge === undefined) {
      setUnavailable(true);
      setLoading(false);
      return null;
    }
    const result = await bridge.snapshot();
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
      setShowWizard(!isConfigured(next));
    })();
  }, [readSnapshot]);

  const stages = useMemo<readonly WizardStage[]>(
    () => (method === "manual" ? MANUAL_STAGES : AUTO_STAGES),
    [method],
  );
  const stageIndex = Math.max(stages.indexOf(stage), 0);
  const environment = snapshot?.environment ?? null;
  const environmentReady = environment?.state === "ready";
  const nextEnabled = stage === "environment" ? environmentReady : stage === "mode";

  const goNext = useCallback(() => {
    if (stage === "environment") {
      if (environmentReady) setStage("mode");
      return;
    }
    if (stage === "mode") setStage(method === "manual" ? "manual" : "apply");
  }, [environmentReady, method, stage]);

  const goPrev = useCallback(() => {
    setError(null);
    setErrorOutput(null);
    if (stage === "mode") setStage("environment");
    if (stage === "apply" || stage === "manual") setStage("mode");
  }, [stage]);

  const recheck = useCallback(async () => {
    setBusy(true);
    setError(null);
    setErrorOutput(null);
    await readSnapshot();
    setBusy(false);
  }, [readSnapshot]);

  const runGuidedSetup = useCallback(async () => {
    const bridge = api.tailnetObserver as typeof api.tailnetObserver | undefined;
    if (busy || bridge === undefined) return;
    setBusy(true);
    setError(null);
    setErrorOutput(null);
    const result = await bridge.guidedSetup();
    if (result.ok) {
      setSnapshot(result.snapshot);
      setChosenPort(result.port);
      setWebOrigin(result.webOrigin);
      setMethod("auto");
      setStage("done");
      setShowWizard(true);
    } else {
      setError(result.error);
      setErrorOutput(result.output);
      // Tailscale stopped being usable between the check and the press, so the
      // step that reports that is the one to stand on — not this one, which has
      // nothing left to offer.
      if (result.error === "tailnet-guided-setup-not-ready") {
        setStage("environment");
        await readSnapshot();
      }
    }
    setBusy(false);
  }, [api, busy, readSnapshot]);

  // The manual form is the wizard's last step as well as the escape hatch on
  // the status card. Only the first of those is a step that can finish, so a
  // save made from the status card refreshes the facts and leaves the form open.
  const finishFromManualForm = useCallback(async () => {
    const next = await readSnapshot();
    if (showWizard && isConfigured(next)) setShowWizard(false);
  }, [readSnapshot, showWizard]);

  const closeWizard = useCallback(() => {
    setShowWizard(false);
    setShowManualForm(false);
    setError(null);
    setErrorOutput(null);
    setStage("environment");
    setMethod("auto");
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
        actions={
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void recheck()}
            data-testid="tailnet-setup-recheck"
          >
            {t("tailnetObserver.refresh")}
          </Button>
        }
      >
        <p className="text-sm text-destructive" data-testid="tailnet-setup-error">
          {error === null
            ? t("tailnetObserver.errorUnavailable")
            : tailnetObserverErrorText(error, t)}
        </p>
      </SettingsSection>
    );
  }

  const derivedOrigin = webOrigin ?? snapshot.derivedWebOrigin;
  const listeningPort = snapshot.listeningPort;
  const serveOn = snapshot.environment.serveConfigured
    && snapshot.environment.serveTargetPort === listeningPort;

  return (
    <SettingsSection
      data-settings-section="remote-tailnet-observer"
      title={t("tailnetSetup.sectionTitle")}
      description={t("tailnetSetup.sectionDescription")}
    >
      {showWizard ? (
        <div
          className="min-w-0 space-y-4"
          data-testid="tailnet-setup-wizard"
          onKeyDown={(event) => {
            // Enter is the only key that advances, and only where the button it
            // stands in for is itself enabled — a disabled Next must not have a
            // working keyboard twin.
            if (event.key !== "Enter" || event.defaultPrevented) return;
            if (!nextEnabled || busy) return;
            event.preventDefault();
            goNext();
          }}
        >
          <p className="text-xs text-muted-foreground" data-testid="tailnet-setup-step-indicator">
            {t("tailnetSetup.stepIndicator", {
              current: String(stageIndex + 1),
              total: String(stages.length),
            })}
            {` · ${t(STAGE_LABEL_KEY[stage])}`}
          </p>

          {stage === "environment" ? (
            <div className="space-y-3" data-testid="tailnet-setup-step-environment">
              <p
                className="rounded-md border border-border bg-card/(--opacity-half) px-3 py-2 text-sm text-muted-foreground"
                data-testid="tailnet-setup-environment"
              >
                {tailnetEnvironmentText(snapshot.environment, t)}
              </p>
              {snapshot.environment.detail === null ? null : (
                <pre
                  className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card/(--opacity-half) px-3 py-2 text-xs text-muted-foreground"
                  data-testid="tailnet-setup-environment-detail"
                >
                  {snapshot.environment.detail}
                </pre>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void recheck()}
                data-testid="tailnet-setup-recheck"
              >
                {t("tailnetSetup.recheck")}
              </Button>
            </div>
          ) : null}

          {stage === "mode" ? (
            <div className="space-y-3" data-testid="tailnet-setup-step-mode">
              <RadioGroup
                value={method}
                onValueChange={(next: string) => setMethod(next as SetupMethod)}
                aria-label={t("tailnetSetup.modeLegend")}
              >
                <label className="flex min-w-0 items-start gap-3 rounded-md border border-border bg-card/(--opacity-half) px-3 py-2">
                  <RadioGroupItem
                    className="mt-1"
                    value="auto"
                    data-testid="tailnet-setup-mode-auto"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {t("tailnetSetup.modeAutoTitle")}
                    </span>
                    <span className="mt-1 block text-sm text-muted-foreground">
                      {t("tailnetSetup.modeAutoDescription")}
                    </span>
                  </span>
                </label>
                <label className="flex min-w-0 items-start gap-3 rounded-md border border-border bg-card/(--opacity-half) px-3 py-2">
                  <RadioGroupItem
                    className="mt-1"
                    value="manual"
                    data-testid="tailnet-setup-mode-manual"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {t("tailnetSetup.modeManualTitle")}
                    </span>
                    <span className="mt-1 block text-sm text-muted-foreground">
                      {t("tailnetSetup.modeManualDescription")}
                    </span>
                  </span>
                </label>
              </RadioGroup>
            </div>
          ) : null}

          {stage === "apply" ? (
            <div className="space-y-3" data-testid="tailnet-setup-step-apply">
              <p className="text-sm font-medium">{t("tailnetSetup.applyTitle")}</p>
              <p className="text-sm text-muted-foreground">
                {t("tailnetSetup.applyDescription")}
              </p>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void runGuidedSetup()}
                data-testid="tailnet-setup-apply"
              >
                {busy ? t("tailnetSetup.applying") : t("tailnetSetup.applyButton")}
              </Button>
              {error === "tailnet-guided-setup-port-unavailable" ? (
                <Button
                  className="ms-2"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setMethod("manual");
                    setStage("manual");
                  }}
                  data-testid="tailnet-setup-apply-manual"
                >
                  {t("tailnetSetup.manualShow")}
                </Button>
              ) : null}
            </div>
          ) : null}

          {stage === "done" ? (
            <div className="space-y-3" data-testid="tailnet-setup-step-done">
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
                <Button size="sm" onClick={closeWizard} data-testid="tailnet-setup-close">
                  {t("tailnetSetup.close")}
                </Button>
              </div>
            </div>
          ) : null}

          {stage === "manual" ? (
            <div data-testid="tailnet-setup-step-manual">
              <TailnetObserverSection api={api} onHostStateChanged={finishFromManualForm} />
            </div>
          ) : null}

          {error === null || stage === "environment" ? null : (
            <p className="text-sm text-destructive" data-testid="tailnet-setup-error">
              {tailnetObserverErrorText(error, t)}
            </p>
          )}

          {errorOutput === null || stage === "environment" ? null : (
            <pre
              className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive"
              data-testid="tailnet-setup-error-output"
            >
              {errorOutput}
            </pre>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {stageIndex === 0 || stage === "done" ? null : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={goPrev}
                data-testid="tailnet-setup-back"
              >
                {t("tailnetSetup.back")}
              </Button>
            )}
            {stage === "environment" || stage === "mode" ? (
              <Button
                size="sm"
                disabled={!nextEnabled || busy}
                onClick={goNext}
                data-testid="tailnet-setup-next"
              >
                {t("tailnetSetup.next")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="min-w-0 space-y-3" data-testid="tailnet-setup-status">
          <p className="text-sm font-medium">{t("tailnetSetup.statusTitle")}</p>
          <p className="text-sm text-muted-foreground" data-testid="tailnet-setup-status-environment">
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
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void runGuidedSetup()}
              data-testid="tailnet-setup-reconfigure"
            >
              {busy ? t("tailnetSetup.applying") : t("tailnetSetup.reconfigure")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-expanded={showManualForm}
              onClick={() => setShowManualForm((shown) => !shown)}
              data-testid="tailnet-setup-manual-toggle"
            >
              {showManualForm ? t("tailnetSetup.manualHide") : t("tailnetSetup.manualShow")}
            </Button>
          </div>
          {error === null ? null : (
            <p className="text-sm text-destructive" data-testid="tailnet-setup-error">
              {tailnetObserverErrorText(error, t)}
            </p>
          )}
          {errorOutput === null ? null : (
            <pre
              className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive"
              data-testid="tailnet-setup-error-output"
            >
              {errorOutput}
            </pre>
          )}
          {showManualForm ? (
            <div data-testid="tailnet-setup-manual-form">
              <TailnetObserverSection api={api} onHostStateChanged={finishFromManualForm} />
            </div>
          ) : null}
        </div>
      )}
    </SettingsSection>
  );
}
