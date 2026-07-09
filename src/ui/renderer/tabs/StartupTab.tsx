import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Switch } from "../../../components/ui/switch.js";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";
import { getApi } from "../api-client.js";
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
  const [closeBehavior, setCloseBehavior] = useState<"hide-to-tray" | "quit">("hide-to-tray");
  const [capturing, setCapturing] = useState(false);
  const captureInputRef = useRef<HTMLDivElement | null>(null);

  const applySnapshot = useCallback((s: AppSettings) => {
    setEnabled(s.shortcuts?.enabled ?? false);
    setToggleWindow(s.shortcuts?.toggleWindow ?? null);
    setLaunchAtStartup(s.system?.launchAtStartup ?? false);
    setLaunchMinimized(s.system?.launchMinimized ?? false);
    setCloseBehavior(s.system?.closeBehavior ?? "hide-to-tray");
    setLoaded(true);
  }, []);

  useEffect(() => {
    let alive = true;
    void api.getSettings().then((s) => {
      if (alive) applySnapshot(s);
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
    (next: { launchAtStartup?: boolean; launchMinimized?: boolean; closeBehavior?: "hide-to-tray" | "quit" }) => {
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
    <div className="space-y-6">
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
          <div className="space-y-0.5">
            <div className="text-sm font-medium">{t("startupTab.shortcutEnabledLabel")}</div>
            <div className="text-xs text-muted-foreground">
              {t("startupTab.shortcutEnabledHint")}
            </div>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={handleEnabledChange}
            disabled={!loaded}
            aria-label={t("startupTab.shortcutEnabledLabel")}
            data-testid="startup-shortcut-enabled"
          />
        </div>

        <div className="mt-4 space-y-2">
          <div className="text-sm font-medium">{t("startupTab.shortcutAcceleratorLabel")}</div>
          <div className="flex items-center gap-2">
            <div
              ref={captureInputRef}
              tabIndex={0}
              role="textbox"
              aria-label={t("startupTab.shortcutAcceleratorLabel")}
              onKeyDown={handleKeyCapture}
              onBlur={() => setCapturing(false)}
              data-testid="startup-accelerator-capture"
              className={[
                "flex h-9 min-w-[220px] items-center rounded-md border px-3 text-sm",
                capturing
                  ? "border-primary ring-2 ring-primary/(--opacity-medium) text-foreground"
                  : "border-input text-muted-foreground",
              ].join(" ")}
            >
              {capturing
                ? t("startupTab.shortcutCapturing")
                : toggleWindow ?? t("startupTab.shortcutUnset")}
            </div>
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
          <div className="space-y-0.5">
            <div className="text-sm font-medium">{t("startupTab.launchAtStartupLabel")}</div>
            <div className="text-xs text-muted-foreground">
              {t("startupTab.launchAtStartupHint")}
            </div>
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
          <div className="space-y-0.5">
            <div className="text-sm font-medium">{t("startupTab.launchMinimizedLabel")}</div>
            <div className="text-xs text-muted-foreground">
              {t("startupTab.launchMinimizedHint")}
            </div>
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
            <RadioGroupItem value="hide-to-tray" id="close-hide-to-tray" className="mt-0.5" />
            <Label htmlFor="close-hide-to-tray" className="cursor-pointer">
              <div className="font-medium">{t("generalTab.hideToTrayLabel")}</div>
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
