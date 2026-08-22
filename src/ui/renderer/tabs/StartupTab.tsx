import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Switch } from "../../../components/ui/switch.js";
import { Label } from "../../../components/ui/label.js";
import { Input } from "../../../components/ui/input.js";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../../components/ui/radio-group.js";
import { SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import { getApi } from "../api-client.js";
import { envVarForSettingsPath } from "../../../shared/env-backed-settings.js";
import { DEFAULT_CORP_CA_COMMON_NAME } from "../../../shared/corp-ca-common-name.js";
import { normalizeAccelerator } from "../../../shared/shortcuts.js";
import { eventToAccelerator } from "../utils/accelerator-capture.js";
import type { AppSettings } from "../types.js";

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
  const [envForcedPaths, setEnvForcedPaths] = useState<readonly string[]>([]);
  // Corporate root CA. Acquired and injected before `bootstrap()`, so — like
  // the GPU switch above — these are next-launch settings, and the section
  // says so instead of implying an effect they do not have.
  const [corpCaEnabled, setCorpCaEnabled] = useState(true);
  const [corpCaDebugLog, setCorpCaDebugLog] = useState(false);
  const [corpCaCommonName, setCorpCaCommonName] = useState(DEFAULT_CORP_CA_COMMON_NAME);
  // Draft state: the name is a text field, so persisting per keystroke would
  // write a partial name to the profile the next launch reads.
  const [corpCaNameDraft, setCorpCaNameDraft] = useState(DEFAULT_CORP_CA_COMMON_NAME);
  // The last name the host reported. `applySnapshot` runs again on EVERY
  // settings update, including ones this tab caused (flipping a switch in this
  // same section) and ones from elsewhere entirely — so it reseeds the draft
  // only when the draft still matches what was stored, or it would wipe a name
  // the user is halfway through typing.
  const storedCorpCaNameRef = useRef(DEFAULT_CORP_CA_COMMON_NAME);
  const [capturing, setCapturing] = useState(false);
  const captureInputRef = useRef<HTMLDivElement | null>(null);

  const applySnapshot = useCallback((s: AppSettings) => {
    setEnabled(s.shortcuts?.enabled ?? false);
    setToggleWindow(s.shortcuts?.toggleWindow ?? null);
    setLaunchAtStartup(s.system?.launchAtStartup ?? false);
    setLaunchMinimized(s.system?.launchMinimized ?? false);
    setCloseBehavior(s.system?.closeBehavior ?? "hide-to-tray");
    setHardwareAcceleration(s.system?.hardwareAcceleration ?? true);
    setCorpCaEnabled(s.system?.corpCaEnabled ?? true);
    setCorpCaDebugLog(s.system?.corpCaDebugLog ?? false);
    const name = s.system?.corpCaCommonName ?? DEFAULT_CORP_CA_COMMON_NAME;
    const previousName = storedCorpCaNameRef.current;
    storedCorpCaNameRef.current = name;
    setCorpCaCommonName(name);
    setCorpCaNameDraft((draft) => (draft === previousName ? name : draft));
    setLoaded(true);
  }, []);

  useEffect(() => {
    let alive = true;
    void api.getSettings().then((s) => {
      if (alive) applySnapshot(s);
    });
    void api.envForcedSettings().then((paths) => {
      if (alive) setEnvForcedPaths(paths);
    });
    const unsub = api.onSettingsUpdated((s) => applySnapshot(s));
    return () => {
      alive = false;
      unsub();
    };
  }, [api, applySnapshot]);

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

  const commitCorpCaCommonName = useCallback(() => {
    const next = corpCaNameDraft.trim();
    // An emptied field means "use the default" rather than "search for
    // nothing"; the host applies the same rule, so show what will be saved.
    const applied = next === "" ? DEFAULT_CORP_CA_COMMON_NAME : next;
    setCorpCaCommonName(applied);
    setCorpCaNameDraft(applied);
    persistSystem({ corpCaCommonName: applied });
  }, [corpCaNameDraft, persistSystem]);

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
        {envForcedPaths.includes("system.hardwareAcceleration") ? (
          <p
            className="mt-2 text-xs text-muted-foreground"
            data-testid="startup-hardware-acceleration-forced"
          >
            {t("startupTab.hardwareAccelerationEnvForced", {
              envVar: envVarForSettingsPath("system.hardwareAcceleration") ?? "",
            })}
          </p>
        ) : null}
      </SettingsSection>

      {/* Corporate root CA — see corp-ca-runtime.ts. Electron has two TLS
          stacks: Chromium trusts the OS store, Node does not, so on a network
          with a TLS-inspecting proxy the browser half works while every model
          call fails. This is the control for the half that fails. */}
      <SettingsSection
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
        {envForcedPaths.includes("system.corpCaEnabled") ? (
          <p
            className="mt-2 text-xs text-muted-foreground"
            data-testid="startup-corp-ca-enabled-forced"
          >
            {t("startupTab.corpCaEnabledEnvForced", {
              envVar: envVarForSettingsPath("system.corpCaEnabled") ?? "",
            })}
          </p>
        ) : null}

        <div className="mt-4 space-y-2">
          <Label className="text-sm font-medium" htmlFor="startup-corp-ca-common-name">
            {t("startupTab.corpCaCommonNameLabel")}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="startup-corp-ca-common-name"
              value={corpCaNameDraft}
              onChange={(e) => setCorpCaNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commitCorpCaCommonName(); }}
              disabled={!loaded || !corpCaEnabled}
              className="flex-1"
              data-testid="startup-corp-ca-common-name"
            />
            <Button
              type="button"
              size="sm"
              onClick={commitCorpCaCommonName}
              disabled={!loaded || corpCaNameDraft.trim() === corpCaCommonName}
              data-testid="startup-corp-ca-common-name-save"
            >
              {t("common.save")}
            </Button>
          </div>
          <p
            className="text-xs text-muted-foreground"
            data-testid="startup-corp-ca-common-name-help"
          >
            {t("startupTab.corpCaCommonNameHelp")}
          </p>
          {envForcedPaths.includes("system.corpCaCommonName") ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="startup-corp-ca-common-name-forced"
            >
              {t("startupTab.corpCaCommonNameEnvForced", {
                envVar: envVarForSettingsPath("system.corpCaCommonName") ?? "",
              })}
            </p>
          ) : null}
        </div>

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
        {envForcedPaths.includes("system.corpCaDebugLog") ? (
          <p
            className="mt-2 text-xs text-muted-foreground"
            data-testid="startup-corp-ca-debug-forced"
          >
            {t("startupTab.corpCaDebugEnvForced", {
              envVar: envVarForSettingsPath("system.corpCaDebugLog") ?? "",
            })}
          </p>
        ) : null}
      </SettingsSection>

      {/* Window close behavior (moved from the former General tab) */}
      <SettingsSection
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
      </SettingsSection>
    </div>
  );
}
