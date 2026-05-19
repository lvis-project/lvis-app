/**
 * Demo activation IPC handler.
 *
 * Flow:
 *   1. The LoginModal renders an activation-input sub-state when the user
 *      clicks chip 1 ("데모 자격증명으로 30초 안에 체험"). The user pastes a
 *      `LVIS-DEMO:v1:<base64>` activation string distributed through an
 *      internal channel.
 *   2. The renderer calls `api.demo.activate(code)` over IPC.
 *   3. This handler decrypts the string into the original `.env.demo`
 *      plaintext, persists it to `~/.lvis/secrets/.env.demo` (0o600), and
 *      injects the parsed `KEY=VALUE` pairs into `process.env` so the
 *      existing `captureDemoCredentials()` machinery can pick them up.
 *   4. The handler calls `recaptureDemoCredentialsAfterActivation()` so the
 *      auth IPC handler's subsequent `loginMockup` call observes the
 *      freshly-injected demo keys instead of the empty boot-time capture.
 *   5. The renderer then proceeds with the existing `loginMockup` chain.
 *
 * Why a separate IPC handler (not folded into `auth.ts`):
 *   - The activation step is a *prerequisite* to `loginMockup`. Folding it
 *     into auth.ts would conflate "I have credentials, please log me in"
 *     with "I need to install credentials before logging in".
 *   - The packaged-build path also calls the same activation handler on
 *     first run, AND on subsequent boots when `~/.lvis/secrets/.env.demo`
 *     already exists (see `loadPersistedDemoActivation` below). Auth is
 *     downstream of activation; clean separation keeps the wiring honest.
 *
 * Error contract (CLAUDE.md):
 *   - IPC error codes are kebab-case English. Renderer translates to Korean.
 *   - `invalid-code` covers: bad prefix, corrupt base64, GCM auth tag
 *     mismatch (wrong passphrase, tampered ciphertext), empty payload.
 *   - `persist-failed` covers: filesystem write failures (permission,
 *     disk full, parent dir missing).
 *   - `no-vendor` covers: decrypted payload missing `LVIS_DEMO_VENDOR`.
 *
 * Storage namespace (project CLAUDE.md "Storage Namespace per Feature"):
 *   The persisted `.env.demo` lives under `~/.lvis/secrets/` (cross-cutting
 *   secrets directory, not a per-feature namespace) because the payload IS
 *   a credentials artifact and lives alongside the encrypted secret store
 *   blob. Directory mode 0o700, file mode 0o600.
 */
import { ipcMain } from "electron";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { createLogger } from "../../lib/logger.js";
import {
  decryptActivationCode,
  parseEnvDemoText,
} from "../../main/demo-activation-codec.js";
import { persistedEnvDemoPath } from "../../main/demo-activation-loader.js";
import { recaptureDemoCredentialsAfterActivation } from "../../main/demo-credentials.js";
import type { IpcDeps } from "../types.js";

const log = createLogger("demo-activation-ipc");

/**
 * Inject the parsed `.env.demo` key/value pairs into `process.env`. Mirrors
 * the dev-time `scripts/run-electron.mjs` loader so the *same* runtime
 * environment is reconstituted whether the user is on dev (file on disk
 * at repo root) or packaged (activated string → persisted file → injected).
 *
 * Existing keys are NOT overwritten — same precedence rule as
 * `run-electron.mjs`: shell env wins, file fills the gaps. This means a
 * developer can locally override the activation string by exporting the
 * env var directly.
 */
export function injectDemoEnv(parsed: Record<string, string>): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

/**
 * Atomic write: write to a sibling `.tmp` then rename. Prevents a
 * half-written `.env.demo` from being read by a subsequent boot if the
 * process crashes mid-write. The temp file is created with the same 0o600
 * mode so a partial write never widens the permission window.
 */
async function writeEnvDemoFile(path: string, contents: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, contents, { mode: 0o600 });
  await fs.rename(tmp, path);
}

export function registerDemoHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  ipcMain.handle(
    "lvis:demo:activate",
    async (
      e,
      payload: { code?: unknown },
    ): Promise<
      | { ok: true; vendor: string }
      | { ok: false; error: "invalid-code" | "persist-failed" | "no-vendor" | "unauthorized-frame" }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:demo:activate", e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }

      const code = typeof payload?.code === "string" ? payload.code : "";
      if (code.length === 0) {
        return { ok: false, error: "invalid-code" };
      }

      // Step 1 — decrypt. Wraps the codec throw into the kebab-case IPC
      // error code per the CLAUDE.md error-language rule. Auth-tag mismatch
      // (wrong passphrase / tampered ciphertext) lands here.
      let plaintext: string;
      try {
        plaintext = decryptActivationCode(code);
      } catch (err) {
        log.info(`activation rejected: ${(err as Error).message}`);
        try {
          auditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "auth",
            type: "warn",
            input: "[demo-activation] invalid-code (decrypt failed)",
          });
        } catch { /* audit must not break IPC */ }
        return { ok: false, error: "invalid-code" };
      }

      // Step 2 — parse + validate vendor presence. The decrypted file must
      // contain `LVIS_DEMO_VENDOR` for the auth IPC handler to know which
      // vendor to activate. No vendor → no path forward; surface a distinct
      // error so the renderer can tell the user the payload was malformed
      // versus the code was wrong.
      const parsed = parseEnvDemoText(plaintext);
      const vendor = parsed.LVIS_DEMO_VENDOR;
      if (typeof vendor !== "string" || vendor.length === 0) {
        log.warn("activation payload missing LVIS_DEMO_VENDOR");
        return { ok: false, error: "no-vendor" };
      }

      // Step 3 — persist to disk so the next boot auto-activates. The file
      // path matches what `loadPersistedDemoActivation()` reads on startup
      // — same single source of truth, no drift between write and read.
      try {
        await writeEnvDemoFile(persistedEnvDemoPath(), plaintext);
      } catch (err) {
        log.error(
          `failed to persist .env.demo: ${(err as Error).message}`,
        );
        return { ok: false, error: "persist-failed" };
      }

      // Step 4 — inject the parsed values into `process.env` AND re-run the
      // demo-credentials capture so the auth IPC handler sees the new keys.
      // The injection runs first because `recaptureDemoCredentialsAfterActivation`
      // reads from `process.env`.
      injectDemoEnv(parsed);
      recaptureDemoCredentialsAfterActivation();

      try {
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "auth",
          type: "info",
          input: `[demo-activation] activated vendor=${vendor} keys=${Object.keys(parsed).length}`,
        });
      } catch { /* audit must not break IPC */ }

      log.info(`demo activation succeeded: vendor=${vendor}`);
      return { ok: true, vendor };
    },
  );
}
