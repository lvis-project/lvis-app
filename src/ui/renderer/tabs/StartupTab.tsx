import { useCallback, useRef, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Switch } from "../../../components/ui/switch.js";
import { Label } from "../../../components/ui/label.js";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../../components/ui/radio-group.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import { EnvForcedNotice, useEnvForcedSettings } from "../components/EnvForcedNotice.js";
import { SettingsTextField } from "../components/SettingsTextField.js";
import { getApi } from "../api-client.js";
import { DEFAULT_CORP_CA_COMMON_NAME } from "../../../shared/corp-ca-common-name.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";
import { normalizeAccelerator } from "../../../shared/shortcuts.js";
import { eventToAccelerator } from "../utils/accelerator-capture.js";
import type { AppSettings } from "../types.js";
import { useSettingsSnapshot } from "../hooks/use-settings-snapshot.js";

/**
 * The cleanup windows the control offers, in milliseconds.
 *
 * A fixed list rather than a free number field: the setting is a deadline the
 * app enforces on itself while quitting, and the two ways to get it wrong —
 * too short to finish writing, long enough that quitting appears to hang —
 * are both reachable by typing. The environment variable still accepts any
 * positive value, which is the escape hatch for the deployment that needs one.
 *
 * The shipped default has to be one of these or the control would render a
 * selection the user cannot choose again, so it is taken from the policy
 * rather than restated.
 */
const SHUTDOWN_CLEANUP_TIMEOUT_CHOICES_MS: readonly number[] = Object.freeze([
  5_000,
  TOOL_TIMEOUT_POLICY.shutdownCleanupMs,
  30_000,
  60_000,
]);

/**
 * E4 — Startup / global shortcuts settings tab.
 *
 * Reuses the existing settings IPC (`getSettings`/`updateSettings`/
 * `onSettingsUpdated`) — no dedicated channel (see `.omc/plans/e4-design.md`).
 * All state is immediate-apply: toggling a switch or capturing an accelerator
 * writes through `updateSettings`, which triggers the main-process reconcilers
 * that (re)register the global shortcut + OS login item.
 */
export function StartupTab() {
  const { t } = useTranslation();
  const api = getApi();

  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [toggleWindow, setToggleWindow] = useState<string | null>(null);
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [launchMinimized, setLaunchMinimized] = useState(false);
  // Default mirrors `DEFAULT_SETTINGS.system.closeBehavior` so the radio group
  // renders the correct selection even before `settings` arrives.
  const [closeBehavior, setCloseBehavior] = useState<"hide-to-tray" | "quit">(
    "hide-to-tray",
  );
  // Placeholder only. `normalizeSystem` backfills the platform-derived default
  // on every load, so the first real snapshot always carries a concrete boolean
  // and the switch stays disabled until it arrives.
  const [hardwareAcceleration, setHardwareAcceleration] = useState(true);
  // Settings whose value the environment is deciding right now. A control that
  // rendered only what is stored would be telling the user something untrue of
  // the running app, so each affected control names its variable.
  const envForcedPaths = useEnvForcedSettings(api);
  // Corporate root CA. Acquired and injected before `bootstrap()`, so — like
  // the GPU switch above — these are next-launch settings, and the section
  // says so instead of implying an effect they do not have.
  // Quit-time cleanup window. Unlike the switches above this one IS applied to
  // the running app: the value is read when `before-quit` fires, so a change
  // takes effect on the next quit rather than the next launch.
  const [shutdownCleanupTimeoutMs, setShutdownCleanupTimeoutMs] = useState<number>(
    TOOL_TIMEOUT_POLICY.shutdownCleanupMs,
  );
  const [corpCaEnabled, setCorpCaEnabled] = useState(true);
  const [corpCaDebugLog, setCorpCaDebugLog] = useState(false);
  // The name the host last reported. `SettingsTextField` owns the draft — it
  // reseeds only when this value actually moves, so the re-render caused by
  // flipping a switch in this same section cannot wipe a name the user is
  // halfway through typing.
  const [corpCaCommonName, setCorpCaCommonName] = useState(DEFAULT_CORP_CA_COMMON_NAME);
  const [capturing, setCapturing] = useState(false);
  const captureInputRef = useRef<HTMLDivElement | null>(null);

  const applySnapshot = useCallback((s: AppSettings) => {
    setEnabled(s.shortcuts?.enabled ?? false);
    setToggleWindow(s.shortcuts?.toggleWindow ?? null);
    setLaunchAtStartup(s.system?.launchAtStartup ?? false);
    setLaunchMinimized(s.system?.launchMinimized ?? false);
    setCloseBehavior(s.system?.closeBehavior ?? "hide-to-tray");
    setHardwareAcceleration(s.system?.hardwareAcceleration ?? true);
    setShutdownCleanupTimeoutMs(
      s.system?.shutdownCleanupTimeoutMs ?? TOOL_TIMEOUT_POLICY.shutdownCleanupMs,
    );
    setCorpCaEnabled(s.system?.corpCaEnabled ?? true);
    setCorpCaDebugLog(s.system?.corpCaDebugLog ?? false);
    setCorpCaCommonName(s.system?.corpCaCommonName ?? DEFAULT_CORP_CA_COMMON_NAME);
    setLoaded(true);
  }, []);

  useSettingsSnapshot(api, applySnapshot);

  const persistShortcuts = useCallback(
    (next: { toggleWindow?: string | null; enabled?: boolean }) => {
      void api.updateSettings({ shortcuts: next });
    },
    [api],
  );

  const persistSystem = useCallback(
    (next: {
      launchAtStartup?: boolean;
      launchMinimized?: boolean;
      closeBehavior?: "hide-to-tray" | "quit";
      hardwareAcceleration?: boolean;
      corpCaEnabled?: boolean;
      corpCaCommonName?: string;
      corpCaDebugLog?: boolean;
      shutdownCleanupTimeoutMs?: number;
    }) => {
      void api.updateSettings({ system: next });
    },
    [api],
  );

  const handleEnabledChange = useCallback(
    (value: boolean) => {
      setEnabled(value);
      persistShortcuts({ enabled: value });
    },
    [persistShortcuts],
  );

  const handleLaunchAtStartupChange = useCallback(
    (value: boolean) => {
      setLaunchAtStartup(value);
      // Turning auto-launch off also clears the "start hidden" sub-preference in
      // the UI so it can't linger as a confusing enabled-but-inert toggle. The
      // persisted value is kept (main derives hidden only when launchAtStartup),
      // but we send both so the OS login item is rewritten coherently.
      persistSystem({ launchAtStartup: value });
    },
    [persistSystem],
  );

  const handleLaunchMinimizedChange = useCallback(
    (value: boolean) => {
      setLaunchMinimized(value);
      persistSystem({ launchMinimized: value });
    },
    [persistSystem],
  );

  const handleHardwareAccelerationChange = useCallback(
    (value: boolean) => {
      setHardwareAcceleration(value);
      // Persisted only. `app.disableHardwareAcceleration()` is a
      // before-whenReady call, so nothing about the running process changes —
      // the next launch reads this back through
      // `readPersistedHardwareAccelerationSync`. The section copy says so
      // rather than letting the switch imply an effect it does not have.
      persistSystem({ hardwareAcceleration: value });
    },
    [persistSystem],
  );

  const handleCorpCaEnabledChange = useCallback(
    (value: boolean) => {
      setCorpCaEnabled(value);
      persistSystem({ corpCaEnabled: value });
    },
    [persistSystem],
  );

  const handleCorpCaDebugLogChange = useCallback(
    (value: boolean) => {
      setCorpCaDebugLog(value);
      persistSystem({ corpCaDebugLog: value });
    },
    [persistSystem],
  );

  // An emptied field means "use the default" rather than "search for nothing";
  // the host applies the same rule, so the field shows what will be saved.
  const normalizeCorpCaCommonName = useCallback(
    (raw: string) => raw.trim() || DEFAULT_CORP_CA_COMMON_NAME,
    [],
  );

  const commitCorpCaCommonName = useCallback(
    (applied: string) => {
      setCorpCaCommonName(applied);
      persistSystem({ corpCaCommonName: applied });
    },
    [persistSystem],
  );

  const handleShutdownTimeoutChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const value = Number(event.target.value);
      // The option values come from the frozen list above, so a value outside
      // it means the DOM was tampered with rather than a choice being made.
      if (!SHUTDOWN_CLEANUP_TIMEOUT_CHOICES_MS.includes(value)) return;
      setShutdownCleanupTimeoutMs(value);
      persistSystem({ shutdownCleanupTimeoutMs: value });
    },
    [persistSystem],
  );

  const handleCloseBehaviorChange = useCallback(
    (value: string) => {
      if (value !== "hide-to-tray" && value !== "quit") return;
      setCloseBehavior(value);
      persistSystem({ closeBehavior: value });
    },
    [persistSystem],
  );

  const handleKeyCapture = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!capturing) return;
      e.preventDefault();
      e.stopPropagation();
      // Escape cancels capture without changing the binding.
      if (e.key === "Escape") {
        setCapturing(false);
        return;
      }
      const accel = eventToAccelerator(e);
      if (accel === null) return; // modifier-only press — keep waiting for a key.
      const normalized = normalizeAccelerator(accel);
      if (normalized === null) return;
      setToggleWindow(normalized);
      setCapturing(false);
      persistShortcuts({ toggleWindow: normalized });
    },
    [capturing, persistShortcuts],
  );

  const handleClearAccelerator = useCallback(() => {
    setToggleWindow(null);
    setCapturing(false);
    persistShortcuts({ toggleWindow: null });
  }, [persistShortcuts]);

  const startCapture = useCallback(() => {
    setCapturing(true);
    // Focus the capture box so keydown lands here.
    requestAnimationFrame(() => captureInputRef.current?.focus());
  }, []);

  return (
    <div className="min-w-0 space-y-6">
      <SettingsPageHeader
        title={t("startupTab.title")}
        description={t("startupTab.description")}
      />

      {/* Global shortcut — show/hide window toggle */}
      <SettingsSection
        data-settings-section="startup-shortcut"
        title={t("startupTab.shortcutSectionTitle")}
        description={t("startupTab.shortcutSectionDesc")}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="min-w-0 text-sm font-medium">
              {t("startupTab.shortcutEnabledLabel")}
            </span>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={handleEnabledChange}
            disabled={!loaded}
            aria-label={t("startupTab.shortcutEnabledLabel")}
            data-testid="startup-shortcut-enabled"
          />
        </div>

        <div className="mt-4 min-w-0 space-y-2">
          <div className="text-sm font-medium">
            {t("startupTab.shortcutAcceleratorLabel")}
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            <div
              ref={captureInputRef}
              tabIndex={0}
              role="textbox"
              aria-label={t("startupTab.shortcutAcceleratorLabel")}
              onKeyDown={handleKeyCapture}
              onBlur={() => setCapturing(false)}
              data-testid="startup-accelerator-capture"
              className={[
                "flex h-9 w-full min-w-0 items-center rounded-md border px-3 text-sm sm:w-auto sm:min-w-[220px]",
                capturing
                  ? "border-primary ring-2 ring-primary/(--opacity-medium) text-foreground"
                  : "border-input text-muted-foreground",
              ].join(" ")}
            >
              {capturing
                ? t("startupTab.shortcutCapturing")
                : (toggleWindow ?? t("startupTab.shortcutUnset"))}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={startCapture}
                disabled={!loaded}
                data-testid="startup-accelerator-record"
              >
                {t("startupTab.shortcutRecord")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClearAccelerator}
                disabled={!loaded || toggleWindow === null}
                data-testid="startup-accelerator-clear"
              >
                {t("startupTab.shortcutClear")}
              </Button>
            </div>
          </div>
          {enabled && toggleWindow === null ? (
            <p className="text-xs text-warning">
              {t("startupTab.shortcutEnabledNoAccelerator")}
            </p>
          ) : null}
        </div>
      </SettingsSection>

      {/* Launch at startup */}
      <SettingsSection
        data-settings-section="startup-launch"
        title={t("startupTab.launchSectionTitle")}
        description={t("startupTab.launchSectionDesc")}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="min-w-0 text-sm font-medium">
              {t("startupTab.launchAtStartupLabel")}
            </span>
          </div>
          <Switch
            checked={launchAtStartup}
            onCheckedChange={handleLaunchAtStartupChange}
            disabled={!loaded}
            aria-label={t("startupTab.launchAtStartupLabel")}
            data-testid="startup-launch-at-startup"
          />
        </div>

        <div className="mt-4 flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="min-w-0 text-sm font-medium">
              {t("startupTab.launchMinimizedLabel")}
            </span>
          </div>
          <Switch
            checked={launchMinimized}
            onCheckedChange={handleLaunchMinimizedChange}
            disabled={!loaded || !launchAtStartup}
            aria-label={t("startupTab.launchMinimizedLabel")}
            data-testid="startup-launch-minimized"
          />
        </div>
      </SettingsSection>

      {/* Rendering — the only lever for a machine whose GPU driver crashes the
          renderer. It was `LVIS_KEEP_GPU=1` and nothing else, which a packaged
          app's user cannot set. */}
      <SettingsSection
        data-settings-section="startup-rendering"
        title={t("startupTab.renderingSectionTitle")}
        description={t("startupTab.renderingSectionDesc")}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="min-w-0 text-sm font-medium">
              {t("startupTab.hardwareAccelerationLabel")}
            </span>
          </div>
          <Switch
            checked={hardwareAcceleration}
            onCheckedChange={handleHardwareAccelerationChange}
            disabled={!loaded}
            aria-label={t("startupTab.hardwareAccelerationLabel")}
            data-testid="startup-hardware-acceleration"
          />
        </div>
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="startup-hardware-acceleration-help"
        >
          {t("startupTab.hardwareAccelerationHelp")}
        </p>
        <EnvForcedNotice
          settingsPath="system.hardwareAcceleration"
          forcedPaths={envForcedPaths}
          messageKey="startupTab.hardwareAccelerationEnvForced"
          testId="startup-hardware-acceleration-forced"
          className="mt-2"
        />
      </SettingsSection>

      {/* Corporate root CA — see corp-ca-runtime.ts. Electron has two TLS
          stacks: Chromium trusts the OS store, Node does not, so on a network
          with a TLS-inspecting proxy the browser half works while every model
          call fails. This is the control for the half that fails. */}
      <SettingsSection
        data-settings-section="startup-corp-ca"
        title={t("startupTab.corpCaSectionTitle")}
        description={t("startupTab.corpCaSectionDesc")}
      >
        <div className="flex items-center justify-between gap-4">
          <span className="min-w-0 text-sm font-medium">
            {t("startupTab.corpCaEnabledLabel")}
          </span>
          <Switch
            checked={corpCaEnabled}
            onCheckedChange={handleCorpCaEnabledChange}
            disabled={!loaded}
            aria-label={t("startupTab.corpCaEnabledLabel")}
            data-testid="startup-corp-ca-enabled"
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="startup-corp-ca-help">
          {t("startupTab.corpCaEnabledHelp")}
        </p>
        <EnvForcedNotice
          settingsPath="system.corpCaEnabled"
          forcedPaths={envForcedPaths}
          messageKey="startupTab.corpCaEnabledEnvForced"
          testId="startup-corp-ca-enabled-forced"
          className="mt-2"
        />

        <SettingsTextField
          id="startup-corp-ca-common-name"
          label={t("startupTab.corpCaCommonNameLabel")}
          help={t("startupTab.corpCaCommonNameHelp")}
          value={corpCaCommonName}
          onCommit={commitCorpCaCommonName}
          normalize={normalizeCorpCaCommonName}
          disabled={!loaded || !corpCaEnabled}
          className="mt-4"
        >
          <EnvForcedNotice
            settingsPath="system.corpCaCommonName"
            forcedPaths={envForcedPaths}
            messageKey="startupTab.corpCaCommonNameEnvForced"
            testId="startup-corp-ca-common-name-forced"
          />
        </SettingsTextField>

        <div className="mt-4 flex items-center justify-between gap-4">
          <span className="min-w-0 text-sm font-medium">
            {t("startupTab.corpCaDebugLabel")}
          </span>
          <Switch
            checked={corpCaDebugLog}
            onCheckedChange={handleCorpCaDebugLogChange}
            disabled={!loaded}
            aria-label={t("startupTab.corpCaDebugLabel")}
            data-testid="startup-corp-ca-debug"
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="startup-corp-ca-debug-help">
          {t("startupTab.corpCaDebugHelp")}
        </p>
        <EnvForcedNotice
          settingsPath="system.corpCaDebugLog"
          forcedPaths={envForcedPaths}
          messageKey="startupTab.corpCaDebugEnvForced"
          testId="startup-corp-ca-debug-forced"
          className="mt-2"
        />
      </SettingsSection>

      {/* Window close behavior (moved from the former General tab) */}
      <SettingsSection
        data-settings-section="startup-system-behavior"
        title={t("generalTab.systemBehaviorTitle")}
        description={t("generalTab.systemBehaviorDescription")}
      >
        <RadioGroup
          value={closeBehavior}
          onValueChange={handleCloseBehaviorChange}
          className="gap-3"
        >
          <div className="flex items-start gap-3 rounded-md border bg-card/(--opacity-half) p-3">
            <RadioGroupItem
              value="hide-to-tray"
              id="close-hide-to-tray"
              className="mt-0.5"
            />
            <Label htmlFor="close-hide-to-tray" className="cursor-pointer">
              <div className="font-medium">
                {t("generalTab.hideToTrayLabel")}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("generalTab.hideToTrayDescription")}
              </div>
            </Label>
          </div>
          <div className="flex items-start gap-3 rounded-md border bg-card/(--opacity-half) p-3">
            <RadioGroupItem value="quit" id="close-quit" className="mt-0.5" />
            <Label htmlFor="close-quit" className="cursor-pointer">
              <div className="font-medium">{t("generalTab.quitLabel")}</div>
              <div className="text-xs text-muted-foreground">
                {t("generalTab.quitDescription")}
              </div>
            </Label>
          </div>
        </RadioGroup>

        <div className="mt-4 border-t pt-4">
          <Label htmlFor="shutdown-cleanup-timeout" className="font-medium">
            {t("startupTab.shutdownTimeoutLabel")}
          </Label>
          <NativeSelect
            id="shutdown-cleanup-timeout"
            className="mt-2 w-full"
            value={String(shutdownCleanupTimeoutMs)}
            onChange={handleShutdownTimeoutChange}
            disabled={!loaded || envForcedPaths.includes("system.shutdownCleanupTimeoutMs")}
            data-testid="startup-shutdown-timeout"
          >
            {SHUTDOWN_CLEANUP_TIMEOUT_CHOICES_MS.map((ms) => (
              <NativeSelectOption key={ms} value={String(ms)}>
                {t(
                  ms === TOOL_TIMEOUT_POLICY.shutdownCleanupMs
                    ? "startupTab.shutdownTimeoutSecondsDefault"
                    : "startupTab.shutdownTimeoutSeconds",
                  { seconds: String(Math.round(ms / 1000)) },
                )}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p
            className="mt-2 text-xs text-muted-foreground"
            data-testid="startup-shutdown-timeout-help"
          >
            {t("startupTab.shutdownTimeoutHelp")}
          </p>
          <EnvForcedNotice
            settingsPath="system.shutdownCleanupTimeoutMs"
            forcedPaths={envForcedPaths}
            messageKey="startupTab.shutdownTimeoutEnvForced"
            testId="startup-shutdown-timeout-forced"
            className="mt-2"
          />
        </div>
      </SettingsSection>
    </div>
  );
}
