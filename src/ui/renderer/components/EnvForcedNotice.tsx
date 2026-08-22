/**
 * "The environment is deciding this setting" notice — one implementation.
 *
 * Every env-backed setting has the same two-part surface: a control that shows
 * the stored value, and a line telling the user the running app is ignoring it
 * because a variable is set. Each settings tab used to hand-roll that line —
 * the `includes()` test, the variable lookup, the missing-variable fallback,
 * the `-forced` test id, the muted-text classes — so the wording and the
 * behaviour could drift per tab, and every newly surfaced variable meant
 * copying the block again. It is one component now: the tab supplies only what
 * genuinely differs (which setting, which sentence, which test id).
 */
import { useEffect, useState } from "react";
import { envVarForSettingsPath } from "../../../shared/env-backed-settings.js";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";

/** The one call this hook makes — so a tab can hand it an injected api. */
export interface EnvForcedSettingsReader {
  envForcedSettings: () => Promise<readonly string[]>;
}

/**
 * The settings paths the environment is currently forcing.
 *
 * The host is the authority — it is the process that can see its own
 * environment — so this is an IPC read, not a renderer-side re-derivation of
 * ENV_BACKED_SETTINGS. Returns `[]` until the answer arrives, which renders no
 * notice: claiming "the environment decides this" before knowing would be the
 * one wrong thing to show.
 *
 * `api` is optional because the settings tabs disagree on how they get one:
 * some receive it as a prop (and their tests never initialize the global), the
 * rest reach for the module-level accessor. Taking it as an argument lets both
 * kinds share this hook instead of keeping their own copy of the fetch.
 */
export function useEnvForcedSettings(api?: EnvForcedSettingsReader): readonly string[] {
  const [paths, setPaths] = useState<readonly string[]>([]);
  useEffect(() => {
    let alive = true;
    void (api ?? getApi()).envForcedSettings().then((forced) => {
      if (alive) setPaths(forced);
    });
    return () => { alive = false; };
  }, [api]);
  return paths;
}

export interface EnvForcedNoticeProps {
  /** Settings path this notice is about, e.g. `system.corpCaEnabled`. */
  readonly settingsPath: string;
  /** The forced set, from {@link useEnvForcedSettings}. */
  readonly forcedPaths: readonly string[];
  /** i18n key for the sentence; it receives the variable name as `envVar`. */
  readonly messageKey: string;
  readonly testId: string;
  /** Spacing for the surrounding layout — the text styling is not negotiable. */
  readonly className?: string;
}

/**
 * Render the notice, or nothing.
 *
 * Nothing is also the answer when the path is forced but no variable is known
 * for it: a sentence naming an empty variable tells the user less than silence.
 */
export function EnvForcedNotice({
  settingsPath,
  forcedPaths,
  messageKey,
  testId,
  className,
}: EnvForcedNoticeProps) {
  const { t } = useTranslation();
  if (!forcedPaths.includes(settingsPath)) return null;
  const envVar = envVarForSettingsPath(settingsPath);
  if (!envVar) return null;
  return (
    <p
      className={`text-xs text-muted-foreground${className ? ` ${className}` : ""}`}
      data-testid={testId}
    >
      {t(messageKey, { envVar })}
    </p>
  );
}
