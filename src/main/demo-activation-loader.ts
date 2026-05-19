/**
 * Demo activation boot loader — reads the persisted `.env.demo` payload
 * (written by the `lvis:demo:activate` IPC handler) on app boot and
 * injects the values into `process.env`, mirroring the dev-mode
 * `scripts/run-electron.mjs` `.env.demo` autoload.
 *
 * Lives in a separate module from `demo-activation-codec.ts` so the
 * codec stays pure (crypto + parser only, no filesystem or LVIS-home
 * imports). This lets the `scripts/encrypt-demo-credentials.mjs` CLI
 * tool import the codec without pulling in main-process-only paths.
 *
 * Storage namespace per CLAUDE.md "Storage Namespace per Feature":
 *   `~/.lvis/secrets/.env.demo` (mode 0o600). `secrets/` is the
 *   cross-cutting credentials directory shared with the encrypted secret
 *   store, which is the correct namespace for a credentials artifact.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { lvisHome } from "../shared/lvis-home.js";
import { parseEnvDemoText } from "./demo-activation-codec.js";

/**
 * Resolve the on-disk path for the activated `.env.demo` payload. Single
 * source of truth — both the IPC handler (write side) and the boot-time
 * loader (read side) call this helper so the path can never drift.
 */
export function persistedEnvDemoPath(): string {
  return join(lvisHome(), "secrets", ".env.demo");
}

/**
 * Boot-time loader for a previously-persisted `.env.demo` payload. Runs
 * synchronously because `main.ts` needs the env vars in place BEFORE
 * `captureDemoCredentials()` reads `process.env`, and the existing boot
 * path is fully synchronous up to `app.whenReady()`.
 *
 * Existing keys are NOT overwritten — same precedence rule as
 * `scripts/run-electron.mjs`: the shell environment wins, the persisted
 * file fills the gaps. Lets a developer override the activated values by
 * setting the env var directly before launch.
 *
 * Returns the parsed key/value pairs so callers can audit-log the count
 * without re-reading the file. Empty object when the file is absent.
 */
export function loadPersistedDemoActivationSync(): Record<string, string> {
  const path = persistedEnvDemoPath();
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Permission errors / transient FS issues — return empty so the user
    // can re-activate via the LoginModal. We do not log here because the
    // logger is not yet wired at the point this helper is called during
    // main.ts boot.
    return {};
  }
  const parsed = parseEnvDemoText(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
  return parsed;
}
