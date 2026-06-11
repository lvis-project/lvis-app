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
import { decryptActivationCode, parseEnvDemoText } from "./demo-activation-codec.js";
import { getEmbeddedActivationCode } from "./demo-embedded-activation.js";

/**
 * Resolve the on-disk path for the activated `.env.demo` payload. Single
 * source of truth — both the IPC handler (write side) and the boot-time
 * loader (read side) call this helper so the path can never drift.
 */
export function persistedEnvDemoPath(): string {
  return join(lvisHome(), "secrets", ".env.demo");
}

/**
 * Sentinel recording that the user explicitly logged out of the demo
 * (`lvis:demo:clear`). While present, {@link loadEmbeddedDemoActivationSync}
 * refuses to re-hydrate from the build-embedded key, so a deliberate logout
 * is NOT undone on the next boot. Cleared when the user re-activates (manual
 * paste or the embedded chip). Lives next to the credentials artifact under
 * `~/.lvis/secrets/` (written mode 0o600).
 */
export function demoDisabledSentinelPath(): string {
  return join(lvisHome(), "secrets", ".demo-disabled");
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

/**
 * Boot-time hydrate from the build-embedded activation key. Used ONLY when
 * no `.env.demo` was persisted yet (fresh install / first launch on an
 * internal-distribution build). Decrypts the embedded ciphertext and injects
 * the values into `process.env` so the downstream `applyDemoHostResolverRules`
 * can wire Chromium host-resolver-rules on THIS boot — eliminating the
 * first-activation relaunch (the Chromium command line is frozen after
 * `app.whenReady()`, so without this the host map only takes effect on a
 * subsequent boot, which is why activation previously forced a restart).
 *
 * No-op when:
 *   - a persisted `.env.demo` already exists — {@link loadPersistedDemoActivationSync}
 *     owns that case and takes precedence;
 *   - no embedded key (manual-paste / public builds → `getEmbeddedActivationCode()` null);
 *   - the demo-disabled sentinel exists — the user explicitly logged out, so
 *     a build-embedded key must NOT silently resurrect the demo session.
 *
 * Deliberately does NOT write `.env.demo` to disk — this is an idempotent
 * in-memory hydrate. Persisting would fight a later `lvis:demo:clear` (which
 * removes the file): the embedded key would just re-create it every boot.
 * A malformed embedded ciphertext returns `{}` (falls through to the manual
 * paste flow) — the one permitted fallback class (external-boundary input).
 *
 * Same key-precedence rule as the persisted loader: existing `process.env`
 * keys are never overwritten.
 */
export function loadEmbeddedDemoActivationSync(): Record<string, string> {
  if (existsSync(persistedEnvDemoPath())) return {};
  if (existsSync(demoDisabledSentinelPath())) return {};
  const code = getEmbeddedActivationCode();
  if (code === null) return {};
  let text: string;
  try {
    text = decryptActivationCode(code);
  } catch {
    // Malformed embedded ciphertext (e.g. issued before a passphrase
    // rotation). Fall through to the manual-paste activation flow rather
    // than crash boot. Not logged — the logger is not yet wired here.
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
