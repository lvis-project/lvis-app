/**
 * Local-owner controls for the loopback API and the A2A route families.
 *
 * All four gates are read as `settings || env` at boot, and all four already
 * had a settings key — what they did not have was anywhere to set it. A
 * packaged app cannot be launched with `LVIS_LOCAL_API=1`, so for the user the
 * app ships to these were unreachable, and the CLI companion and every A2A
 * route with them.
 *
 * The switches write the settings key and nothing else. Because the host reads
 * them once at boot, the section says a change waits for the next launch
 * rather than implying the surface came up; and because the environment wins
 * over the saved value, it names any variable that is currently forcing one on.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Switch } from "../../../components/ui/switch.js";
import { SettingsSection } from "../components/PageShell.js";
import { EnvForcedNotice, useEnvForcedSettings } from "../components/EnvForcedNotice.js";
import { getApi } from "../api-client.js";
import { isIpcErrorResult } from "../types.js";
import type { AppSettings, DeepPartial } from "../types.js";

/** One switch: the settings path it writes, and the text that explains it. */
interface GateRow {
  readonly path: "system.localApiServer"
    | "features.a2aLoopbackServer"
    | "features.a2aRemoteRouting"
    | "features.a2aRemoteReceiver";
  readonly testId: string;
  readonly labelKey: string;
  readonly hintKey: string;
}

const ROWS: readonly GateRow[] = Object.freeze([
  {
    path: "system.localApiServer",
    testId: "local-api-surfaces-local-api",
    labelKey: "localApiSurfaces.localApiLabel",
    hintKey: "localApiSurfaces.localApiHint",
  },
  {
    path: "features.a2aLoopbackServer",
    testId: "local-api-surfaces-a2a-loopback",
    labelKey: "localApiSurfaces.a2aLoopbackLabel",
    hintKey: "localApiSurfaces.a2aLoopbackHint",
  },
  {
    path: "features.a2aRemoteRouting",
    testId: "local-api-surfaces-a2a-remote-routing",
    labelKey: "localApiSurfaces.a2aRemoteRoutingLabel",
    hintKey: "localApiSurfaces.a2aRemoteRoutingHint",
  },
  {
    path: "features.a2aRemoteReceiver",
    testId: "local-api-surfaces-a2a-remote-receiver",
    labelKey: "localApiSurfaces.a2aRemoteReceiverLabel",
    hintKey: "localApiSurfaces.a2aRemoteReceiverHint",
  },
] as const);

type GateState = Record<GateRow["path"], boolean>;

const ALL_OFF: GateState = Object.freeze({
  "system.localApiServer": false,
  "features.a2aLoopbackServer": false,
  "features.a2aRemoteRouting": false,
  "features.a2aRemoteReceiver": false,
});

/**
 * The settings patch for one gate.
 *
 * Written out rather than split from the dotted path so the patch is typed
 * against the settings shape: a key renamed in the store breaks this at
 * compile time instead of silently writing a field nothing reads.
 */
function patchFor(path: GateRow["path"], value: boolean): DeepPartial<AppSettings> {
  switch (path) {
    case "system.localApiServer":
      return { system: { localApiServer: value } };
    case "features.a2aLoopbackServer":
      return { features: { a2aLoopbackServer: value } };
    case "features.a2aRemoteRouting":
      return { features: { a2aRemoteRouting: value } };
    case "features.a2aRemoteReceiver":
      return { features: { a2aRemoteReceiver: value } };
  }
}

export function LocalApiSurfacesSection() {
  const { t } = useTranslation();
  const [gates, setGates] = useState<GateState>(ALL_OFF);
  const forced = useEnvForcedSettings();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<GateRow["path"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const settings = await getApi().getSettings();
      setGates({
        "system.localApiServer": settings.system?.localApiServer === true,
        "features.a2aLoopbackServer": settings.features?.a2aLoopbackServer === true,
        "features.a2aRemoteRouting": settings.features?.a2aRemoteRouting === true,
        "features.a2aRemoteReceiver": settings.features?.a2aRemoteReceiver === true,
      });
      setError(null);
    } catch {
      setError(t("localApiSurfaces.loadFailed"));
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(async (path: GateRow["path"], next: boolean) => {
    if (busy !== null) return;
    setBusy(path);
    // Optimistic, then reverted on refusal: the switch is the only feedback
    // the user gets for a change whose effect is a launch away.
    setGates((current) => ({ ...current, [path]: next }));
    const result = await getApi().updateSettings(patchFor(path, next));
    if (isIpcErrorResult(result)) {
      setGates((current) => ({ ...current, [path]: !next }));
      setError(result.message ?? t("localApiSurfaces.saveFailed"));
    } else {
      setError(null);
    }
    setBusy(null);
  }, [busy, t]);

  if (loading) {
    return (
      <SettingsSection title={t("localApiSurfaces.sectionTitle")}>
        <p className="text-sm text-muted-foreground" data-testid="local-api-surfaces-loading">
          {t("localApiSurfaces.loading")}
        </p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title={t("localApiSurfaces.sectionTitle")}
      description={t("localApiSurfaces.sectionDescription")}
    >
      <div className="space-y-4">
        {ROWS.map((row) => {
          return (
            <div key={row.path} className="grid gap-1">
              <div className="flex items-center justify-between gap-4">
                <span className="min-w-0 text-sm font-medium">{t(row.labelKey)}</span>
                <Switch
                  checked={gates[row.path]}
                  onCheckedChange={(next: boolean) => void toggle(row.path, next)}
                  disabled={busy !== null}
                  aria-label={t(row.labelKey)}
                  data-testid={row.testId}
                />
              </div>
              <span className="text-xs text-muted-foreground">{t(row.hintKey)}</span>
              <EnvForcedNotice
                settingsPath={row.path}
                forcedPaths={forced}
                messageKey="localApiSurfaces.envForced"
                testId={`${row.testId}-forced`}
              />
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-xs text-muted-foreground" data-testid="local-api-surfaces-restart-note">
        {t("localApiSurfaces.restartRequired")}
      </p>

      {error !== null ? (
        <p className="mt-2 text-xs text-destructive" data-testid="local-api-surfaces-error">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
