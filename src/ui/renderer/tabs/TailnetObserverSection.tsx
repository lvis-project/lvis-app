/**
 * Local-owner controls for the Tailnet observer listener.
 *
 * The observer used to be configurable only through boot environment
 * variables, which a packaged app has no way to set — so the listener, paired
 * sharing, the controller, and the web surface were all unreachable for the
 * user the app ships to, and "off" was indistinguishable from "not built".
 *
 * This section renders whether or not sharing is currently available, because
 * it is the control that makes sharing available in the first place. It reads a
 * host-owned snapshot and proposes a whole configuration; the host validates,
 * persists, and decides.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Switch } from "../../../components/ui/switch.js";
import { SettingsSection, type SettingsSectionFeedback } from "../components/PageShell.js";
import {
  DEFAULT_TAILNET_OBSERVER_VIEW_PORT,
  TAILNET_OBSERVER_CONFIG_KEYS,
  type TailnetObserverConfigKeyView,
  type TailnetObserverConfigView,
  type TailnetObserverSnapshot,
} from "../../../shared/tailnet-observer-config.js";
import { useCopyFlash } from "../hooks/use-copy-flash.js";
import type { LvisApi } from "../types.js";

export interface TailnetObserverSectionProps {
  api: Pick<LvisApi, "tailnetObserver">;
}

/** What a save writes when the owner asks to start over from a damaged file. */
const RESET_CONFIG: TailnetObserverConfigView = Object.freeze({
  enabled: false,
  // Starting over lands on the default boundary, not on a half-filled advanced
  // one: identity mode needs nothing typed to be valid.
  authorization: { kind: "tailnet-identity" as const },
  port: DEFAULT_TAILNET_OBSERVER_VIEW_PORT,
  controllerEnabled: false,
  pairedSharingEnabled: false,
  webEnabled: false,
  webOrigin: "",
});

/**
 * Kebab-case codes from the host, rendered as localized text.
 *
 * Unknown codes fall back to the generic failure rather than being echoed:
 * every known code is a classification of the user's own proposal, and an
 * unrecognized one is not something to put on screen verbatim. Every code the
 * host can produce has a sentence here — a start failure landing on "could not
 * be saved" was itself one of the dead ends.
 */
function errorText(code: string, t: (key: string) => string): string {
  switch (code) {
    case "tailnet-observer-authorization-missing-or-invalid":
      return t("tailnetObserver.errorAuthorization");
    case "tailnet-observer-port-invalid":
      return t("tailnetObserver.errorPort");
    case "tailnet-controller-requires-paired-sharing":
      return t("tailnetObserver.errorControllerNeedsPairing");
    case "tailnet-web-requires-paired-sharing":
      return t("tailnetObserver.errorWebNeedsPairing");
    case "tailnet-web-origin-missing-or-invalid":
      return t("tailnetObserver.errorWebOrigin");
    case "tailnet-web-origin-underivable":
      return t("tailnetObserver.errorWebOriginUnderivable");
    case "tailnet-observer-config-file-invalid":
    case "tailnet-observer-config-file-unreadable":
      return t("tailnetObserver.errorConfigFile");
    case "tailnet-controller-command-port-unavailable":
      return t("tailnetObserver.errorControllerPort");
    case "tailnet-paired-sharing-runtime-unavailable":
      return t("tailnetObserver.errorPairedSharingRuntime");
    case "tailnet-observer-not-composed":
    case "tailnet-observer-stopped":
      return t("tailnetObserver.errorListenerUnreachable");
    case "tailnet-serve-not-listening":
      return t("tailnetObserver.errorServeNotListening");
    case "tailnet-serve-tailscale-cli-not-found":
      return t("tailnetObserver.environmentCliNotFound");
    case "tailnet-serve-tailscale-logged-out":
      return t("tailnetObserver.environmentLoggedOut");
    case "tailnet-serve-tailscale-stopped":
      return t("tailnetObserver.environmentStopped");
    case "tailnet-serve-tailscale-cli-failed":
      return t("tailnetObserver.environmentCliFailed");
    case "tailnet-serve-magic-dns-missing":
      return t("tailnetObserver.errorMagicDnsMissing");
    case "tailnet-serve-cli-not-found":
      return t("tailnetObserver.environmentCliNotFound");
    case "tailnet-serve-command-failed":
      return t("tailnetObserver.errorServeCommandFailed");
    case "user-keyboard-required":
      return t("tailnetObserver.errorKeyboardIntent");
    case "tailnet-observer-unavailable":
      return t("tailnetObserver.errorUnavailable");
    default:
      return t("tailnetObserver.errorGeneric");
  }
}

/** The one sentence this desktop's Tailscale state deserves. */
function environmentText(
  environment: TailnetObserverSnapshot["environment"],
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  switch (environment.state) {
    case "ready":
      return t("tailnetObserver.environmentReady", {
        login: environment.login ?? t("tailnetObserver.environmentUnknownLogin"),
        node: environment.dnsName ?? t("tailnetObserver.environmentNoMagicDns"),
      });
    case "logged-out":
      return t("tailnetObserver.environmentLoggedOut");
    case "stopped":
      return t("tailnetObserver.environmentStopped");
    case "cli-not-found":
      return t("tailnetObserver.environmentCliNotFound");
    case "cli-failed":
      return t("tailnetObserver.environmentCliFailed");
  }
}

function sourceLabel(
  key: TailnetObserverConfigKeyView,
  snapshot: TailnetObserverSnapshot,
  t: (key: string) => string,
): string | null {
  return snapshot.provenance[key] === "env-override"
    ? t("tailnetObserver.sourceEnvOverride")
    : null;
}

export function TailnetObserverSection({ api }: TailnetObserverSectionProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<TailnetObserverSnapshot | null>(null);
  const [draft, setDraft] = useState<TailnetObserverConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<SettingsSectionFeedback>(null);
  const [serveUrl, setServeUrl] = useState<string | null>(null);
  const [serveOutput, setServeOutput] = useState<string | null>(null);
  const { copied, copy: copyToClipboard } = useCopyFlash();
  // Toggling back to identity mode must not silently discard a capability the
  // user already typed; the draft keeps it so flipping the switch is reversible.
  const [capabilityDraft, setCapabilityDraft] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    // A host without this namespace — an older preload next to a newer renderer
    // — degrades to "unavailable" rather than throwing: this section mounts in
    // the tab that is the only place the observer can be turned on, so a throw
    // here would take down the surface it exists to provide.
    const bridge = api.tailnetObserver as typeof api.tailnetObserver | undefined;
    if (bridge === undefined) {
      setSnapshot(null);
      setFeedback({ tone: "error", text: t("tailnetObserver.errorUnavailable") });
      setLoading(false);
      return;
    }
    const result = await bridge.snapshot();
    if (result.ok) {
      setSnapshot(result.snapshot);
      setDraft(result.snapshot.saved);
      const saved = result.snapshot.saved.authorization;
      if (saved.kind === "app-capability") setCapabilityDraft(saved.capability);
      setFeedback(null);
    } else {
      setSnapshot(null);
      setFeedback({ tone: "error", text: errorText(result.error, t) });
    }
    setLoading(false);
  }, [api, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async (config: TailnetObserverConfigView) => {
    const bridge = api.tailnetObserver as typeof api.tailnetObserver | undefined;
    if (busy || bridge === undefined) return;
    setBusy(true);
    const result = await bridge.apply(config);
    if (result.ok) {
      // After the refresh, not before: a successful snapshot clears feedback,
      // so setting it first left a save that applied with nothing said about it.
      await refresh();
      setFeedback({ tone: "success", text: t("tailnetObserver.saved") });
    } else {
      setFeedback({ tone: "error", text: errorText(result.error, t) });
    }
    setBusy(false);
  }, [api, busy, refresh, t]);

  const configureServe = useCallback(async () => {
    const bridge = api.tailnetObserver as typeof api.tailnetObserver | undefined;
    if (busy || bridge === undefined) return;
    setBusy(true);
    setServeUrl(null);
    setServeOutput(null);
    const result = await bridge.configureServe();
    if (result.ok) {
      setServeUrl(result.url);
      await refresh();
      setFeedback({ tone: "success", text: t("tailnetObserver.serveConfigured") });
    } else {
      // Tailscale's own sentence, not a paraphrase of it: the certificate case
      // needs a tailnet administrator, and only Tailscale says so.
      setServeOutput(result.output);
      setFeedback({ tone: "error", text: errorText(result.error, t) });
    }
    setBusy(false);
  }, [api, busy, refresh, t]);

  const patch = useCallback((change: Partial<TailnetObserverConfigView>) => {
    setDraft((current) => (current === null ? current : { ...current, ...change }));
  }, []);

  if (loading) {
    return (
      <SettingsSection title={t("tailnetObserver.sectionTitle")}>
        <p className="text-sm text-muted-foreground" data-testid="tailnet-observer-loading">
          {t("tailnetObserver.loading")}
        </p>
      </SettingsSection>
    );
  }

  if (snapshot === null || draft === null) {
    return (
      <SettingsSection
        title={t("tailnetObserver.sectionTitle")}
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refresh()}
            data-testid="tailnet-observer-refresh"
          >
            {t("tailnetObserver.refresh")}
          </Button>
        }
      >
        <p className="text-sm text-destructive" data-testid="tailnet-observer-error">
          {feedback?.text ?? t("tailnetObserver.errorUnavailable")}
        </p>
      </SettingsSection>
    );
  }

  const envOverridden = TAILNET_OBSERVER_CONFIG_KEYS.filter(
    (key) => snapshot.provenance[key] === "env-override",
  );
  const environment = snapshot.environment;
  const webOriginUnavailable = snapshot.derivedWebOrigin === null;

  return (
    <SettingsSection
      title={t("tailnetObserver.sectionTitle")}
      description={t("tailnetObserver.sectionDescription")}
      actions={
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void refresh()}
          data-testid="tailnet-observer-refresh"
        >
          {t("tailnetObserver.refresh")}
        </Button>
      }
    >
      {/* What Tailscale says, read by this app rather than asked for. Every
          value below that used to be a text field comes from here. */}
      <p
        className="rounded-md border border-border bg-card/(--opacity-half) px-3 py-2 text-xs text-muted-foreground"
        data-testid="tailnet-observer-environment"
      >
        {environmentText(environment, t)}
        {/* A personal tailnet is named after its owner's login, so appending it
            unconditionally prints the same address twice. */}
        {environment.tailnetName === null || environment.tailnetName === environment.login
          ? ""
          : ` · ${environment.tailnetName}`}
      </p>

      {environment.detail !== null ? (
        <pre
          className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card/(--opacity-half) px-3 py-2 text-[11px] text-muted-foreground"
          data-testid="tailnet-observer-environment-detail"
        >
          {environment.detail}
        </pre>
      ) : null}

      <p
        className="mt-2 rounded-md border border-border bg-card/(--opacity-half) px-3 py-2 text-xs text-muted-foreground"
        data-testid="tailnet-observer-status"
      >
        {snapshot.listeningPort === null
          ? t("tailnetObserver.statusNotListening")
          : `${t("tailnetObserver.statusListening")} 127.0.0.1:${snapshot.listeningPort}`}
      </p>

      {snapshot.configFileError !== null ? (
        <div
          className="mt-2 rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2"
          data-testid="tailnet-observer-config-file-error"
        >
          <p className="text-xs text-destructive">{errorText(snapshot.configFileError, t)}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("tailnetObserver.configFileRecovery")}
          </p>
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void save(RESET_CONFIG)}
            data-testid="tailnet-observer-reset"
          >
            {t("tailnetObserver.reset")}
          </Button>
        </div>
      ) : null}

      {snapshot.lastStartError !== null ? (
        <p className="mt-2 text-xs text-destructive" data-testid="tailnet-observer-start-error">
          {errorText(snapshot.lastStartError, t)}
        </p>
      ) : null}

      {snapshot.pairedSharingBootstrapFailed ? (
        <p className="mt-2 text-xs text-destructive" data-testid="tailnet-observer-pairing-failed">
          {t("tailnetObserver.pairedSharingBootstrapFailed")}
        </p>
      ) : null}

      {envOverridden.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="tailnet-observer-env-override">
          {t("tailnetObserver.envOverrideNotice")}
        </p>
      ) : null}

      <div className="mt-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <span className="min-w-0 text-sm font-medium">{t("tailnetObserver.enabledLabel")}</span>
          <Switch
            checked={draft.enabled}
            onCheckedChange={(next: boolean) => patch({ enabled: next })}
            disabled={busy}
            aria-label={t("tailnetObserver.enabledLabel")}
            data-testid="tailnet-observer-enabled"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <span className="min-w-0 text-sm font-medium">
            {t("tailnetObserver.appCapabilityLabel")}
            {sourceLabel("authorization", snapshot, t) !== null
              ? ` (${sourceLabel("authorization", snapshot, t)})`
              : ""}
          </span>
          <Switch
            checked={draft.authorization.kind === "app-capability"}
            onCheckedChange={(next: boolean) => patch({
              authorization: next
                ? { kind: "app-capability", capability: capabilityDraft }
                : { kind: "tailnet-identity" },
            })}
            disabled={busy}
            aria-label={t("tailnetObserver.appCapabilityLabel")}
            data-testid="tailnet-observer-app-capability"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {draft.authorization.kind === "app-capability"
            ? t("tailnetObserver.appCapabilityHint")
            : t("tailnetObserver.tailnetIdentityHint")}
        </p>

        {draft.authorization.kind === "app-capability" ? (
          <label className="grid gap-1 text-xs font-medium">
            <span>{t("tailnetObserver.capabilityLabel")}</span>
            <Input
              value={draft.authorization.capability}
              disabled={busy}
              spellCheck={false}
              placeholder="example.com/cap/conversation-observer"
              onChange={(event) => {
                setCapabilityDraft(event.target.value);
                patch({ authorization: { kind: "app-capability", capability: event.target.value } });
              }}
              data-testid="tailnet-observer-capability"
            />
            <span className="font-normal text-muted-foreground">
              {t("tailnetObserver.capabilityHint")}
            </span>
          </label>
        ) : null}

        <label className="grid gap-1 text-xs font-medium">
          <span>{t("tailnetObserver.portLabel")}</span>
          <Input
            type="number"
            value={String(draft.port)}
            disabled={busy}
            onChange={(event) => patch({ port: Number(event.target.value) })}
            data-testid="tailnet-observer-port"
          />
        </label>

        <div className="flex items-center justify-between gap-4">
          <span className="min-w-0 text-sm font-medium">
            {t("tailnetObserver.pairedSharingLabel")}
          </span>
          <Switch
            checked={draft.pairedSharingEnabled}
            onCheckedChange={(next: boolean) => patch({ pairedSharingEnabled: next })}
            disabled={busy}
            aria-label={t("tailnetObserver.pairedSharingLabel")}
            data-testid="tailnet-observer-paired-sharing"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <span className="min-w-0 text-sm font-medium">
            {t("tailnetObserver.controllerLabel")}
          </span>
          <Switch
            checked={draft.controllerEnabled}
            onCheckedChange={(next: boolean) => patch({ controllerEnabled: next })}
            disabled={busy}
            aria-label={t("tailnetObserver.controllerLabel")}
            data-testid="tailnet-observer-controller"
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("tailnetObserver.controllerHint")}</p>

        <div className="flex items-center justify-between gap-4">
          <span className="min-w-0 text-sm font-medium">{t("tailnetObserver.webLabel")}</span>
          <Switch
            checked={draft.webEnabled}
            onCheckedChange={(next: boolean) => patch({ webEnabled: next })}
            disabled={busy || webOriginUnavailable}
            aria-label={t("tailnetObserver.webLabel")}
            data-testid="tailnet-observer-web"
          />
        </div>

        {/* Derived, never typed. An origin that disagrees with the name
            Tailscale serves fails as a bare 403 in the remote browser. */}
        <p className="text-xs text-muted-foreground" data-testid="tailnet-observer-web-origin">
          {webOriginUnavailable
            ? t("tailnetObserver.webOriginUnavailable")
            : `${t("tailnetObserver.webOriginLabel")}: ${snapshot.derivedWebOrigin}`}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void save(draft)}
          data-testid="tailnet-observer-apply"
        >
          {t("tailnetObserver.apply")}
        </Button>
      </div>

      {/* Tailscale Serve is what puts the loopback listener on the tailnet and
          is where the identity headers come from. The command is shown in full
          before anything runs; approving it is the only way it runs. */}
      {snapshot.serveCommand !== null ? (
        <div className="mt-4 border-t border-border pt-3" data-testid="tailnet-observer-serve">
          <p className="text-sm font-medium">{t("tailnetObserver.serveTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {environment.serveTargetPort === snapshot.listeningPort
              ? t("tailnetObserver.serveAlreadyConfigured")
              : t("tailnetObserver.serveDescription")}
          </p>
          <code
            className="mt-2 block max-w-full overflow-x-auto rounded bg-background px-2 py-1 font-mono text-xs"
            data-testid="tailnet-observer-serve-command"
          >
            {snapshot.serveCommand}
          </code>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void configureServe()}
              data-testid="tailnet-observer-serve-run"
            >
              {t("tailnetObserver.serveRun")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => copyToClipboard(snapshot.serveCommand ?? "")}
              data-testid="tailnet-observer-serve-copy"
            >
              {copied ? t("tailnetObserver.copied") : t("tailnetObserver.copy")}
            </Button>
          </div>
          {serveUrl !== null ? (
            <p className="mt-2 text-xs" data-testid="tailnet-observer-serve-url">
              {t("tailnetObserver.serveReachableAt", { url: serveUrl })}
            </p>
          ) : null}
          {serveOutput !== null ? (
            <pre
              className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-[11px] text-destructive"
              data-testid="tailnet-observer-serve-output"
            >
              {serveOutput}
            </pre>
          ) : null}
        </div>
      ) : null}

      {feedback !== null ? (
        <p
          className={`mt-3 text-xs ${feedback.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
          data-testid="tailnet-observer-feedback"
        >
          {feedback.text}
        </p>
      ) : null}
    </SettingsSection>
  );
}
