/**
 * Telemetry surface — rendered at the bottom of the Audit tab, next to
 * diagnostics, because both answer the same question: what leaves this machine.
 *
 * Until this existed the entire `telemetry` settings block was unreachable.
 * `telemetry.enabled` was written exactly once, by the first-boot consent
 * prompt, and there was no second chance to change the answer — a user who
 * accepted could never opt back out, and one who declined could never opt in.
 * The endpoint, the crash-report endpoint and the Sentry DSN were settings the
 * store held and nothing could ever set.
 *
 * The allowlist is shown, not edited. It is the bound on `endpoint`, which the
 * renderer can write — a control the same party could widen would not be a
 * bound. Showing it is still required: without it the endpoint field rejects
 * hosts for reasons the user cannot see.
 */
import { useCallback, useEffect, useState } from "react";
import { Switch } from "../../../components/ui/switch.js";
import { SettingsSection } from "../components/PageShell.js";
import { SettingsTextField } from "../components/SettingsTextField.js";
import { EnvForcedNotice, useEnvForcedSettings } from "../components/EnvForcedNotice.js";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import type { AppSettings } from "../types.js";
import { useSettingsSnapshot } from "../hooks/use-settings-snapshot.js";

/** Every write here is one field; the store merges the rest. */
type TelemetryPatch = Partial<NonNullable<AppSettings["telemetry"]>>;

export function TelemetrySection() {
  const { t } = useTranslation();
  const api = getApi();
  const envForcedPaths = useEnvForcedSettings(api);

  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [crashReportingEnabled, setCrashReportingEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [crashReportEndpoint, setCrashReportEndpoint] = useState("");
  const [sentryDsn, setSentryDsn] = useState("");
  const [allowedHosts, setAllowedHosts] = useState<readonly string[]>([]);

  const applySnapshot = useCallback((s: AppSettings) => {
    setEnabled(s.telemetry?.enabled ?? false);
    setCrashReportingEnabled(s.telemetry?.crashReportingEnabled ?? false);
    setEndpoint(s.telemetry?.endpoint ?? "");
    setCrashReportEndpoint(s.telemetry?.crashReportEndpoint ?? "");
    setSentryDsn(s.telemetry?.sentryDsn ?? "");
    setLoaded(true);
  }, []);

  useSettingsSnapshot(api, applySnapshot);

  useEffect(() => {
    let alive = true;
    void api.telemetryAllowedHosts().then((hosts) => { if (alive) setAllowedHosts(hosts); });
    return () => { alive = false; };
  }, [api]);

  const persist = useCallback(
    (next: TelemetryPatch) => { void api.updateSettings({ telemetry: next }); },
    [api],
  );

  const handleEnabledChange = useCallback((next: boolean) => {
    setEnabled(next);
    // `telemetryPromptAnswered` rides along: reaching this switch at all is an
    // answer, so the first-boot prompt must not reappear afterwards asking a
    // question the user has now answered twice.
    persist({ enabled: next, telemetryPromptAnswered: true });
  }, [persist]);

  const handleCrashReportingChange = useCallback((next: boolean) => {
    setCrashReportingEnabled(next);
    persist({ crashReportingEnabled: next });
  }, [persist]);

  const commitEndpoint = useCallback((next: string) => {
    setEndpoint(next);
    persist({ endpoint: next });
  }, [persist]);

  const commitCrashReportEndpoint = useCallback((next: string) => {
    setCrashReportEndpoint(next);
    persist({ crashReportEndpoint: next });
  }, [persist]);

  const commitSentryDsn = useCallback((next: string) => {
    setSentryDsn(next);
    persist({ sentryDsn: next });
  }, [persist]);

  return (
    <SettingsSection
      title={t("auditTab.telemetrySectionTitle")}
      description={t("auditTab.telemetrySectionDesc")}
    >
      <div className="flex items-center justify-between gap-4">
        <span className="min-w-0 text-sm font-medium">{t("auditTab.telemetryEnabledLabel")}</span>
        <Switch
          checked={enabled}
          onCheckedChange={handleEnabledChange}
          disabled={!loaded}
          aria-label={t("auditTab.telemetryEnabledLabel")}
          data-testid="telemetry-enabled"
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground" data-testid="telemetry-enabled-help">
        {t("auditTab.telemetryEnabledHelp")}
      </p>

      <SettingsTextField
        id="telemetry-endpoint"
        label={t("auditTab.telemetryEndpointLabel")}
        help={t("auditTab.telemetryEndpointHelp")}
        value={endpoint}
        onCommit={commitEndpoint}
        disabled={!loaded}
        placeholder="https://"
        className="mt-4"
      >
        <p className="text-xs text-muted-foreground" data-testid="telemetry-allowed-hosts">
          {t("auditTab.telemetryAllowedHosts", { hosts: allowedHosts.join(", ") })}
        </p>
      </SettingsTextField>

      <div className="mt-4 flex items-center justify-between gap-4">
        <span className="min-w-0 text-sm font-medium">
          {t("auditTab.telemetryCrashReportingLabel")}
        </span>
        <Switch
          checked={crashReportingEnabled}
          onCheckedChange={handleCrashReportingChange}
          disabled={!loaded}
          aria-label={t("auditTab.telemetryCrashReportingLabel")}
          data-testid="telemetry-crash-reporting"
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground" data-testid="telemetry-crash-reporting-help">
        {t("auditTab.telemetryCrashReportingHelp")}
      </p>

      <SettingsTextField
        id="telemetry-crash-endpoint"
        label={t("auditTab.telemetryCrashEndpointLabel")}
        help={t("auditTab.telemetryCrashEndpointHelp")}
        value={crashReportEndpoint}
        onCommit={commitCrashReportEndpoint}
        disabled={!loaded || !crashReportingEnabled}
        placeholder="https://"
        className="mt-4"
      />

      <SettingsTextField
        id="telemetry-sentry-dsn"
        label={t("auditTab.telemetrySentryDsnLabel")}
        help={t("auditTab.telemetrySentryDsnHelp")}
        value={sentryDsn}
        onCommit={commitSentryDsn}
        disabled={!loaded || envForcedPaths.includes("telemetry.sentryDsn")}
        placeholder="https://"
        className="mt-4"
      >
        <EnvForcedNotice
          settingsPath="telemetry.sentryDsn"
          forcedPaths={envForcedPaths}
          messageKey="auditTab.telemetrySentryDsnEnvForced"
          testId="telemetry-sentry-dsn-forced"
        />
      </SettingsTextField>
    </SettingsSection>
  );
}
