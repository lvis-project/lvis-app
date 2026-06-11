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
 *   5. If activation was already effective at boot, the renderer proceeds
 *      with the existing `loginMockup` chain. First activation instead arms
 *      a relaunch; the renderer shows a 5s onboarding notice, then calls the
 *      relaunch IPC so Chromium boots with the new host resolver rules.
 *
 * Why a separate IPC handler (not folded into `auth.ts`):
 *   - The activation step is a *prerequisite* to `loginMockup`. Folding it
 *     into auth.ts would conflate "I have credentials, please log me in"
 *     with "I need to install credentials before logging in".
 *   - The packaged-build path calls this activation handler on first run.
 *     Subsequent boots load `~/.lvis/secrets/.env.demo` before capture; the
 *     renderer then calls `lvis:demo:status` and proceeds to auth directly.
 *     Auth remains downstream of activation; clean separation keeps the
 *     wiring honest.
 *
 * Error contract (CLAUDE.md):
 *   - IPC error codes are kebab-case English. Renderer translates to Korean.
 *   - `invalid-code` covers: bad prefix, corrupt base64, GCM auth tag
 *     mismatch (wrong passphrase, tampered ciphertext), empty payload.
 *   - `persist-failed` covers: filesystem write failures (permission,
 *     disk full, parent dir missing).
 *   - `no-vendor` covers: decrypted payload missing `LVIS_DEMO_VENDOR`.
 *   - `invalid-vendor` covers: decrypted payload has an unknown vendor.
 *   - `no-demo-key` covers: decrypted payload missing the active vendor key.
 *   - `missing-foundry-endpoint` covers: Azure Foundry payload endpoint
 *     missing.
 *   - `invalid-foundry-endpoint` covers: Azure Foundry payload endpoint
 *     rejected by the shared settings endpoint validator.
 *   - `missing-foundry-host-map` covers: Azure Foundry payload missing the
 *     private endpoint host map required for Electron host-resolver-rules.
 *   - `foundry-host-map-mismatch` covers: Azure Foundry endpoint host not
 *     present in `LVIS_DEMO_HOST_MAP`.
 *   - `invalid-foundry-host-map-target` covers: Azure Foundry endpoint host
 *     mapped outside the approved demo private endpoint subnet.
 *
 * Storage namespace (project CLAUDE.md "Storage Namespace per Feature"):
 *   The persisted `.env.demo` lives under `~/.lvis/secrets/` (cross-cutting
 *   secrets directory, not a per-feature namespace) because the payload IS
 *   a credentials artifact and lives alongside the encrypted secret store
 *   blob. Directory mode 0o700, file mode 0o600.
 */
import { app, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { fanOutToAllWindows } from "../broadcast-helpers.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { createLogger } from "../../lib/logger.js";
import {
  decryptActivationCode,
  parseEnvDemoText,
} from "../../main/demo-activation-codec.js";
import {
  demoDisabledSentinelPath,
  persistedEnvDemoPath,
} from "../../main/demo-activation-loader.js";
import {
  getDemoActiveVendor,
  getDemoHostMap,
  getDemoHostSubnet,
  getDemoVendorConfig,
  isDemoEnabled,
  recaptureDemoCredentialsAfterActivation,
  resetDemoCredentials,
} from "../../main/demo-credentials.js";
import { getEmbeddedActivationCode } from "../../main/demo-embedded-activation.js";
import {
  demoFoundryHostMapFingerprint,
  validateDemoFoundryHostMap,
} from "../../main/demo-host-resolver.js";
import { validateFoundryEndpoint } from "../../permissions/reviewer/provider-adapters.js";
import { isLLMVendor } from "../../shared/llm-vendor-defaults.js";
import type { IpcDeps } from "../types.js";
import { DEMO_ACTIVATION_DEV_RELAUNCH_EXIT_CODE } from "../../../scripts/lib/dev-electron-exit.mjs";

const log = createLogger("demo-activation-ipc");

/**
 * 2026-05-20 — cross-window logout / reactivate broadcast channels.
 *
 * Settings 가 별도 BrowserWindow 로 mount 되기 때문에 GeneralTab 의
 * "로그아웃" / "데모 자격증명 재입력" 클릭은 main window 의 onboarding chain
 * + LoginModal 에 도달하지 못한다. 두 채널 모두 *one-way main → renderer*
 * fan-out 이며 payload 가 없는 단순 trigger 이다.
 *
 *   `lvis:auth:logout-reset`            — main window 가 onboarding chain
 *                                         reducer 에 `logout-reset` event 를
 *                                         dispatch 하도록 cue.
 *   `lvis:auth:reactivate-demo`         — main window 가 LoginModal 을
 *                                         `forceActivation=true` 로 mount
 *                                         하도록 cue.
 */
export const AUTH_LOGOUT_RESET_CHANNEL = "lvis:auth:logout-reset";
export const AUTH_REACTIVATE_DEMO_CHANNEL = "lvis:auth:reactivate-demo";

function demoKeyEnvVar(vendor: string): string {
  return `LVIS_DEMO_KEY_${vendor.toUpperCase().replace(/-/g, "_")}`;
}

function requestDemoActivationRelaunch(): void {
  setImmediate(() => {
    try {
      if (process.env.LVIS_DEV === "1" && app.isPackaged === false) {
        app.exit(DEMO_ACTIVATION_DEV_RELAUNCH_EXIT_CODE);
        return;
      }
      app.relaunch();
      app.exit(0);
    } catch (err) {
      log.error(
        `auto-relaunch failed after activation: ${(err as Error).message}`,
      );
    }
  });
}

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

function validateActivationPayloadEndpoint(
  vendor: string,
  parsed: Record<string, string>,
): "missing-foundry-endpoint" | "invalid-foundry-endpoint" | null {
  if (vendor !== "azure-foundry") return null;
  const baseUrl =
    parsed.LVIS_DEMO_BASEURL_AZURE_FOUNDRY ??
    parsed.LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    log.warn("activation payload missing azure-foundry endpoint");
    return "missing-foundry-endpoint";
  }
  try {
    validateFoundryEndpoint(baseUrl);
    return null;
  } catch (err) {
    log.warn(
      `activation payload has invalid azure-foundry endpoint: ${(err as Error).message}`,
    );
    return "invalid-foundry-endpoint";
  }
}

function validateActivationPayloadHostMap(
  vendor: string,
  parsed: Record<string, string>,
): "missing-foundry-host-map" | "foundry-host-map-mismatch" | "invalid-foundry-host-map-target" | null {
  if (vendor !== "azure-foundry") return null;
  const baseUrl =
    parsed.LVIS_DEMO_BASEURL_AZURE_FOUNDRY ??
    parsed.LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY;
  const error = validateDemoFoundryHostMap(baseUrl, parsed.LVIS_DEMO_HOST_MAP, parsed.LVIS_DEMO_HOST_SUBNET);
  if (error !== null) {
    log.warn(`activation payload has invalid azure-foundry host map: ${error}`);
  }
  return error;
}

function demoFoundryResolverFingerprintForCurrentBoot(): string | null {
  if (!isDemoEnabled()) return null;
  const vendor = getDemoActiveVendor();
  if (vendor !== "azure-foundry") return "non-azure-demo";
  const config = getDemoVendorConfig(vendor);
  if (typeof config?.baseUrl !== "string" || config.baseUrl.length === 0) {
    return null;
  }
  try {
    validateFoundryEndpoint(config.baseUrl);
  } catch {
    return null;
  }
  return demoFoundryHostMapFingerprint(config.baseUrl, getDemoHostMap(), getDemoHostSubnet());
}

function demoFoundryResolverFingerprintForPayload(
  vendor: string,
  parsed: Record<string, string>,
): string | null {
  if (vendor !== "azure-foundry") return null;
  const baseUrl =
    parsed.LVIS_DEMO_BASEURL_AZURE_FOUNDRY ??
    parsed.LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY;
  return demoFoundryHostMapFingerprint(baseUrl, parsed.LVIS_DEMO_HOST_MAP, parsed.LVIS_DEMO_HOST_SUBNET);
}

function validateActivationPayloadKey(
  vendor: string,
  parsed: Record<string, string>,
): "no-demo-key" | null {
  const keyEnv = demoKeyEnvVar(vendor);
  const apiKey = parsed[keyEnv];
  if (typeof apiKey === "string" && apiKey.length > 0) return null;
  log.warn(`activation payload missing ${keyEnv}`);
  return "no-demo-key";
}

function broadcastAuthEvent(deps: IpcDeps, channel: string): void {
  // Payload-less one-way main → renderer cue. fanOutToAllWindows composes on
  // safe-send's per-window destroyed-check + send-race swallow, preserving
  // the prior "one window's send failure must not block the others" contract.
  const targets = deps.getAppWindows?.() ?? [deps.getMainWindow()];
  fanOutToAllWindows(targets, channel, undefined);
}

export function registerDemoHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;
  let relaunchArmed = false;
  const demoFoundryResolverFingerprintAtBoot =
    demoFoundryResolverFingerprintForCurrentBoot();
  let demoEffectiveForCurrentProcess =
    demoFoundryResolverFingerprintAtBoot !== null;

  // v0.2.1 hotfix — snapshot whether demo capture was already populated
  // by boot-time `captureDemoCredentials()`. If yes, `.env.demo` was on
  // disk pre-boot and `applyDemoHostResolverRules()` already wired the
  // Azure Foundry hostmap into Chromium's net stack. If no, the current
  // activation is the *first* activation; Chromium command-line is
  // frozen, so retroactive host-resolver-rules cannot apply and we must
  // relaunch on success. Captured at register time (called early during
  // boot, before any activation IPC) so a subsequent activation cannot
  // flip the snapshot.
  const demoWasEffectiveAtBoot = demoFoundryResolverFingerprintAtBoot !== null;

  ipcMain.handle(
    "lvis:demo:status",
    async (
      e,
    ): Promise<
      | { ok: true; activated: boolean; vendor: string | null; autoActivatable: boolean }
      | { ok: false; error: "unauthorized-frame" }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:demo:status", e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      const activated = demoEffectiveForCurrentProcess && isDemoEnabled();
      return {
        ok: true,
        activated,
        vendor: activated ? getDemoActiveVendor() : null,
        // `autoActivatable` tells the renderer this build carries an
        // embedded activation key, so the chip can run the activation
        // chain without mounting the manual paste input.
        autoActivatable: getEmbeddedActivationCode() !== null,
      };
    },
  );

  type ActivationFailureCode =
    | "invalid-code"
    | "persist-failed"
    | "no-vendor"
    | "invalid-vendor"
    | "no-demo-key"
    | "missing-foundry-endpoint"
    | "invalid-foundry-endpoint"
    | "missing-foundry-host-map"
    | "foundry-host-map-mismatch"
    | "invalid-foundry-host-map-target";
  type ActivationOutcome =
    | { ok: true; vendor: string; requiresRelaunch?: boolean }
    | { ok: false; error: ActivationFailureCode };

  /**
   * Activation core — decrypt → validate → persist → inject → recapture →
   * relaunch decision. Shared by the manual paste handler and the
   * embedded-key handler so both supply paths run the exact same
   * validation chain; only the source of the code string differs.
   * `source` is carried into log/audit rows so a support escalation can
   * tell a pasted key apart from a build-embedded one.
   */
  async function performActivation(
    code: string,
    source: "manual" | "embedded",
  ): Promise<ActivationOutcome> {
    // Step 1 — decrypt. Wraps the codec throw into the kebab-case IPC
    // error code per the CLAUDE.md error-language rule. Auth-tag mismatch
    // (wrong passphrase / tampered ciphertext) lands here.
    let plaintext: string;
    try {
      plaintext = decryptActivationCode(code);
    } catch (err) {
      log.info(`activation rejected (source=${source}): ${(err as Error).message}`);
      try {
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "auth",
          type: "warn",
          input: `[demo-activation] invalid-code (decrypt failed, source=${source})`,
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
    if (!isLLMVendor(vendor)) {
      log.warn(`activation payload has invalid LVIS_DEMO_VENDOR: ${vendor}`);
      return { ok: false, error: "invalid-vendor" };
    }
    const keyError = validateActivationPayloadKey(vendor, parsed);
    if (keyError !== null) {
      return { ok: false, error: keyError };
    }
    const endpointError = validateActivationPayloadEndpoint(vendor, parsed);
    if (endpointError !== null) {
      return { ok: false, error: endpointError };
    }
    const hostMapError = validateActivationPayloadHostMap(vendor, parsed);
    if (hostMapError !== null) {
      return { ok: false, error: hostMapError };
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
      // Audit trail for the partial-state outcome (critic MAJOR M3
      // 2026-05-19): the decrypted payload was valid but disk write
      // failed — without an audit row the renderer's "persist-failed"
      // toast is the only forensic evidence. invalid-code branch above
      // already emits a warn row; symmetry across error branches keeps
      // the audit timeline complete for support escalations.
      try {
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "auth",
          type: "warn",
          input: `[demo-activation] persist-failed (source=${source})`,
        });
      } catch { /* audit must not break IPC */ }
      return { ok: false, error: "persist-failed" };
    }

    // A successful (re)activation clears the demo-disabled sentinel left by
    // a prior `lvis:demo:clear`, so an embedded-key build resumes boot-time
    // auto-hydrate on the next launch (the user opted back in). Best-effort:
    // a stale sentinel only costs one extra manual activation, never breaks
    // this activation.
    try {
      await fs.rm(demoDisabledSentinelPath(), { force: true });
    } catch { /* sentinel removal is best-effort — must not break activation */ }

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
        input: `[demo-activation] activated vendor=${vendor} keys=${Object.keys(parsed).length} source=${source}`,
      });
    } catch { /* audit must not break IPC */ }

    log.info(`demo activation succeeded: vendor=${vendor} source=${source}`);

    // v0.2.1 hotfix — First-activation race fix.
    //
    // Chromium command-line switches (host-resolver-rules, used by
    // `applyDemoHostResolverRules` to map the internal Azure Foundry
    // hostname onto the activation-provided intranet subnet) are frozen
    // after `app.whenReady()`. We only call `applyDemoHostResolverRules` once
    // at boot. If `.env.demo` was absent at boot (i.e. this is the very
    // first activation), retroactive `injectDemoEnv` mutates
    // `process.env` but cannot rewire the Chromium net stack — the
    // subsequent `loginMockup` → `refreshProvider` path probes the
    // Azure Foundry endpoint and trips `ENOTFOUND`.
    //
    // The next boot path is correct: `loadPersistedDemoActivationSync()`
    // hydrates `process.env` from `~/.lvis/secrets/.env.demo` BEFORE
    // `applyDemoHostResolverRules()` runs, so host-resolver-rules is
    // armed with the right hostmap by the time renderer code starts.
    // Therefore: on activation success, ask the renderer to surface a
    // brief "재시작 중…" message, then relaunch. In `bun run dev`,
    // the watcher owns that relaunch via a special exit code so it can keep
    // main/preload/renderer/style watchers alive instead of shutting down.
    //
    // `requiresRelaunch=true` is the renderer's cue. The renderer owns
    // the 5s onboarding dwell, then calls `lvis:demo:relaunch-after-activation`
    // to execute the already-armed relaunch. This keeps the message visible
    // before the process exits while preserving the main-process-only
    // relaunch authority.
    const activationFoundryResolverFingerprint =
      demoFoundryResolverFingerprintForPayload(vendor, parsed);
    const shouldRelaunch = vendor === "azure-foundry"
      ? activationFoundryResolverFingerprint !== demoFoundryResolverFingerprintAtBoot
      : !demoWasEffectiveAtBoot;
    demoEffectiveForCurrentProcess = !shouldRelaunch;
    if (shouldRelaunch) {
      relaunchArmed = true;
    }

    return {
      ok: true,
      vendor,
      ...(shouldRelaunch ? { requiresRelaunch: true } : {}),
    };
  }

  ipcMain.handle(
    "lvis:demo:activate",
    async (
      e,
      payload: { code?: unknown },
    ): Promise<ActivationOutcome | { ok: false; error: "unauthorized-frame" }> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:demo:activate", e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      const code = typeof payload?.code === "string" ? payload.code : "";
      if (code.length === 0) {
        return { ok: false, error: "invalid-code" };
      }
      return performActivation(code, "manual");
    },
  );

  ipcMain.handle(
    "lvis:demo:activate-embedded",
    async (
      e,
    ): Promise<
      | ActivationOutcome
      | { ok: false; error: "no-embedded-code" | "unauthorized-frame" }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:demo:activate-embedded", e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      // The embedded code is a compile-time constant, so this only fires
      // when a renderer invokes the channel on a build without one (e.g.
      // a stale renderer talking to a rebuilt main). Distinct error code
      // so the renderer can route the user to the manual paste input.
      const code = getEmbeddedActivationCode();
      if (code === null) {
        return { ok: false, error: "no-embedded-code" };
      }
      return performActivation(code, "embedded");
    },
  );

  ipcMain.handle(
    "lvis:demo:clear",
    async (
      e,
    ): Promise<
      | { ok: true }
      | { ok: false; error: "clear-failed" | "unauthorized-frame" }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:demo:clear", e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      // 2026-05-20 Settings → "데모 자격증명 재입력" 의 보조 path. Logout 버튼이
      // 이 handler 를 호출해 .env.demo + process.env LVIS_DEMO_* + captured
      // 모듈 state 를 한 번에 비운다. 다음 `lvis:demo:status` 호출은 `activated=false`
      // 를 반환하므로 LoginModal 의 activation page 가 다시 mount 된다.
      //
      // 첫 활성 시점의 host-resolver-rules race 와 달리 본 handler 는 Chromium
      // 명령행을 다시 만지지 않는다 — Azure Foundry endpoint 의 hostmap 은 boot
      // 시점 일회성이므로 재활성 시 다시 첫 활성 경로(relaunch 요구) 를 거치게
      // 된다. 본 handler 는 *credential 삭제만* 담당하고 relaunch 는 후속
      // activate handler 가 책임진다.
      relaunchArmed = false;
      demoEffectiveForCurrentProcess = false;
      try {
        const envDemoPath = persistedEnvDemoPath();
        await fs.rm(envDemoPath, { force: true });
        // Drop the demo-disabled sentinel so an embedded-key build does NOT
        // silently re-hydrate the demo session on the next boot. A logout is
        // an explicit "stop using the demo" intent; without the sentinel the
        // build-embedded ciphertext would re-create `.env.demo` every launch.
        // The next manual/embedded activation removes it again (see above).
        try {
          await writeEnvDemoFile(demoDisabledSentinelPath(), "");
        } catch { /* sentinel write is best-effort — must not break clear */ }
        for (const k of Object.keys(process.env)) {
          if (k.startsWith("LVIS_DEMO_")) {
            delete process.env[k];
          }
        }
        resetDemoCredentials();
        try {
          auditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "auth",
            type: "info",
            input: "[demo-activation] cleared",
          });
        } catch { /* audit must not break IPC */ }
        log.info("demo credentials cleared");
        return { ok: true };
      } catch (err) {
        log.error(
          `demo clear failed: ${(err as Error).message}`,
        );
        try {
          auditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "auth",
            type: "warn",
            input: "[demo-activation] clear-failed",
          });
        } catch { /* audit must not break IPC */ }
        return { ok: false, error: "clear-failed" };
      }
    },
  );

  ipcMain.handle(
    "lvis:auth:logout-broadcast",
    async (
      e,
    ): Promise<
      | { ok: true }
      | { ok: false; error: "unauthorized-frame" }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:auth:logout-broadcast", e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      broadcastAuthEvent(deps, AUTH_LOGOUT_RESET_CHANNEL);
      return { ok: true };
    },
  );

  ipcMain.handle(
    "lvis:auth:reactivate-broadcast",
    async (
      e,
    ): Promise<
      | { ok: true }
      | { ok: false; error: "unauthorized-frame" }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:auth:reactivate-broadcast", e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      broadcastAuthEvent(deps, AUTH_REACTIVATE_DEMO_CHANNEL);
      return { ok: true };
    },
  );

  ipcMain.handle(
    "lvis:demo:relaunch-after-activation",
    async (
      e,
    ): Promise<
      | { ok: true }
      | { ok: false; error: "not-armed" | "unauthorized-frame" }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:demo:relaunch-after-activation", e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      if (!relaunchArmed) {
        return { ok: false, error: "not-armed" };
      }
      relaunchArmed = false;
      requestDemoActivationRelaunch();
      return { ok: true };
    },
  );
}
