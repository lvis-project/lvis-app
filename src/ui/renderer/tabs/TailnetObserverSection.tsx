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
  TAILNET_OBSERVER_CONFIG_KEYS,
  type TailnetObserverConfigKeyView,
  type TailnetObserverConfigView,
  type TailnetObserverSnapshot,
} from "../../../shared/tailnet-observer-config.js";
import type { LvisApi } from "../types.js";

export interface TailnetObserverSectionProps {
  api: Pick<LvisApi, "tailnetObserver">;
}

/**
 * Kebab-case codes from the host, rendered as localized text.
 *
 * Unknown codes fall back to the generic failure rather than being echoed:
 * every known code is a classification of the user's own proposal, and an
 * unrecognized one is not something to put on screen verbatim.
 */
function errorText(code: string, t: (key: string) => string): string {
  switch (code) {
    case "tailnet-observer-capability-missing-or-invalid":
      return t("tailnetObserver.errorCapability");
    case "tailnet-observer-port-invalid":
      return t("tailnetObserver.errorPort");
    case "tailnet-controller-requires-paired-sharing":
      return t("tailnetObserver.errorControllerNeedsPairing");
    case "tailnet-web-requires-paired-sharing":
      return t("tailnetObserver.errorWebNeedsPairing");
    case "tailnet-web-origin-missing-or-invalid":
      return t("tailnetObserver.errorWebOrigin");
    case "tailnet-observer-config-file-invalid":
    case "tailnet-observer-config-file-unreadable":
      return t("tailnetObserver.errorConfigFile");
    case "user-keyboard-required":
      return t("tailnetObserver.errorKeyboardIntent");
    case "tailnet-observer-unavailable":
      return t("tailnetObserver.errorUnavailable");
    default:
      return t("tailnetObserver.errorGeneric");
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

  const apply = useCallback(async () => {
    const bridge = api.tailnetObserver as typeof api.tailnetObserver | undefined;
    if (draft === null || busy || bridge === undefined) return;
    setBusy(true);
    const result = await bridge.apply(draft);
    if (result.ok) {
      setFeedback({ tone: "success", text: t("tailnetObserver.saved") });
      await refresh();
    } else {
      setFeedback({ tone: "error", text: errorText(result.error, t) });
    }
    setBusy(false);
  }, [api, busy, draft, refresh, t]);

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
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
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

  return (
    <SettingsSection
      title={t("tailnetObserver.sectionTitle")}
      description={t("tailnetObserver.sectionDescription")}
      actions={
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
          {t("tailnetObserver.refresh")}
        </Button>
      }
    >
      <p
        className="rounded-md border border-border bg-card/(--opacity-half) px-3 py-2 text-xs text-muted-foreground"
        data-testid="tailnet-observer-status"
      >
        {snapshot.listeningPort === null
          ? t("tailnetObserver.statusNotListening")
          : `${t("tailnetObserver.statusListening")} 127.0.0.1:${snapshot.listeningPort}`}
      </p>

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

        <label className="grid gap-1 text-xs font-medium">
          <span>
            {t("tailnetObserver.capabilityLabel")}
            {sourceLabel("expectedAppCapability", snapshot, t) !== null
              ? ` (${sourceLabel("expectedAppCapability", snapshot, t)})`
              : ""}
          </span>
          <Input
            value={draft.expectedAppCapability}
            disabled={busy}
            spellCheck={false}
            placeholder="example.com/cap/conversation-observer"
            onChange={(event) => patch({ expectedAppCapability: event.target.value })}
            data-testid="tailnet-observer-capability"
          />
          <span className="font-normal text-muted-foreground">
            {t("tailnetObserver.capabilityHint")}
          </span>
        </label>

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
            disabled={busy}
            aria-label={t("tailnetObserver.webLabel")}
            data-testid="tailnet-observer-web"
          />
        </div>

        {draft.webEnabled ? (
          <label className="grid gap-1 text-xs font-medium">
            <span>{t("tailnetObserver.webOriginLabel")}</span>
            <Input
              value={draft.webOrigin}
              disabled={busy}
              spellCheck={false}
              placeholder="https://host.tailnet.ts.net"
              onChange={(event) => patch({ webOrigin: event.target.value })}
              data-testid="tailnet-observer-web-origin"
            />
          </label>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void apply()}
          data-testid="tailnet-observer-apply"
        >
          {t("tailnetObserver.apply")}
        </Button>
        {snapshot.restartRequired ? (
          <span className="text-xs text-muted-foreground" data-testid="tailnet-observer-restart-required">
            {t("tailnetObserver.restartRequired")}
          </span>
        ) : null}
      </div>

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
