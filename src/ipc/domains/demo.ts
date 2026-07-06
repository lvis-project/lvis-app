



import { app, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { fanOutToAllWindows } from "../broadcast-helpers.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
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
import { probeOllamaAvailable } from "../../main/ollama-probe.js";
import { validateFoundryEndpoint } from "../../permissions/reviewer/provider-adapters.js";
import {
  isLLMVendor,
  isMarketplaceEligibleLLMVendor,
  OPENAI_COMPATIBLE_VENDOR_PRESETS,
} from "../../shared/llm-vendor-defaults.js";
import type { IpcDeps } from "../types.js";
import { DEMO_ACTIVATION_DEV_RELAUNCH_EXIT_CODE } from "../../../scripts/lib/dev-electron-exit.mjs";

const log = createLogger("demo-activation-ipc");

function marketplaceInstallPatchForDemoVendor(
  deps: IpcDeps,
  vendor: string,
) {
  if (!isMarketplaceEligibleLLMVendor(vendor)) return {};
  const installedProviderIds =
    deps.settingsService.get("marketplace").installedProviderIds ?? [];
  return {
    marketplace: {
      installedProviderIds: installedProviderIds.includes(vendor)
        ? installedProviderIds
        : [...installedProviderIds, vendor],
    },
  };
}




export const AUTH_LOGOUT_RESET_CHANNEL = CHANNELS.auth.logoutReset;
export const AUTH_REACTIVATE_DEMO_CHANNEL = CHANNELS.auth.reactivateDemo;

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

/**
 * #1498 security-MINOR — short-lived cache for the local Ollama liveness probe
 * so a burst of `lvis:demo:status` calls within one login-modal open fires at
 * most one ~500ms network probe instead of one per call. The modal polls
 * status on open (and re-renders can re-invoke it), so an un-cached probe
 * multiplied the latency and the localhost round-trips. The 1.5s TTL is short
 * enough that a user who starts/stops their local Ollama server sees the change
 * on the next modal open, but long enough to collapse a single open's burst.
 */
const OLLAMA_PROBE_CACHE_TTL_MS = 1_500;

/** Cache a single Ollama probe result for a short window (see rationale above). */
function makeCachedOllamaProbe(): () => Promise<boolean> {
  let cachedAt = 0;
  let cached: boolean | null = null;
  let inflight: Promise<boolean> | null = null;
  return async (): Promise<boolean> => {
    const now = Date.now();
    if (cached !== null && now - cachedAt < OLLAMA_PROBE_CACHE_TTL_MS) {
      return cached;
    }
    // Coalesce concurrent callers onto one in-flight probe so a re-render burst
    // that lands within the same tick shares a single network round-trip.
    if (inflight !== null) return inflight;
    inflight = probeOllamaAvailable()
      .then((available) => {
        cached = available;
        cachedAt = Date.now();
        return available;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

export function registerDemoHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;
  let relaunchArmed = false;
  const cachedOllamaProbe = makeCachedOllamaProbe();
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
    CHANNELS.demo.status,
    async (
      e,
    ): Promise<
      | {
          ok: true;
          activated: boolean;
          vendor: string | null;
          autoActivatable: boolean;
          ollamaAvailable: boolean;
        }
      | { ok: false; error: "unauthorized-frame" }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.demo.status, e);
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
        // #1498 — `ollamaAvailable` tells the renderer a local Ollama
        // server answered the liveness probe, so the login modal can offer
        // the "start with a local model" CTA. Probed through a short-lived
        // (1.5s TTL) cache so a burst of status calls within one modal open
        // fires at most one ~500ms probe (security-MINOR: an un-cached probe
        // ran a localhost round-trip per call). The TTL is short enough that
        // a user who starts/stops their local Ollama server between modal
        // opens still sees the change on the next open — never a stale `true`
        // that offers a CTA which then fails, nor a stale `false` that hides a
        // now-available local model. Never shown as `true` when nothing is
        // actually listening (no misleading CTA).
        ollamaAvailable: await cachedOllamaProbe(),
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
    } catch {
      // Best-effort for THIS activation (env is injected below regardless),
      // but a stale sentinel makes the NEXT boot skip auto-hydrate — an
      // unexpected logged-out state with no signal. Audit it so the
      // "asked to activate again on next launch" symptom is debuggable.
      try {
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "auth",
          type: "warn",
          input: `[demo-activation] sentinel-clear-failed (source=${source})`,
        });
      } catch { /* audit must not break IPC */ }
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
    CHANNELS.demo.activate,
    async (
      e,
      payload: { code?: unknown },
    ): Promise<ActivationOutcome | { ok: false; error: "unauthorized-frame" }> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.demo.activate, e);
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
    CHANNELS.demo.activateEmbedded,
    async (
      e,
    ): Promise<
      | ActivationOutcome
      | { ok: false; error: "no-embedded-code" | "unauthorized-frame" }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.demo.activateEmbedded, e);
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
    CHANNELS.demo.activateOllama,
    async (
      e,
    ): Promise<
      | { ok: true; vendor: "ollama" }
      | { ok: false; error: "no-ollama" | "persist-failed" | "unauthorized-frame" }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.demo.activateOllama, e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      // Re-probe rather than trust a status check the renderer ran earlier
      // — the user could have stopped Ollama between opening the login
      // modal and clicking the CTA. Fail closed with a distinct code so
      // the renderer never silently configures a vendor that isn't there.
      const available = await probeOllamaAvailable();
      if (!available) {
        return { ok: false, error: "no-ollama" };
      }
      const preset = OPENAI_COMPATIBLE_VENDOR_PRESETS.ollama;
      // Ollama's local server does not authenticate requests, but the
      // `settings.hasApiKey` gate (used across onboarding/chat to decide
      // whether the app can send a turn) only checks secret-store
      // presence. The preset's own `apiKeyPlaceholder` ("ollama") is the
      // documented placeholder value users already see in Settings → LLM
      // for this vendor, so storing it here is consistent, not a fake
      // secret bypassing a real check.
      //
      // SECURITY NOTE: `preset.apiKeyPlaceholder` is a build-time constant
      // SENTINEL, not a credential — it carries no secret value and is never
      // sent as a bearer token to a real authenticating endpoint. It only
      // satisfies the presence-check gate for a local unauthenticated server.
      const apiKeySecretKey = "llm.apiKey.ollama";
      const prevApiKey = deps.settingsService.getSecret(apiKeySecretKey);
      const prevLlm = deps.settingsService.get("llm");
      const prevMarketplace = deps.settingsService.get("marketplace");
      try {
        await deps.settingsService.setSecret(apiKeySecretKey, preset.apiKeyPlaceholder);
        await deps.settingsService.patch({
          ...marketplaceInstallPatchForDemoVendor(deps, "ollama"),
          llm: {
            authMode: "login",
            provider: "ollama",
            vendors: {
              ollama: {
                baseUrl: preset.baseUrl,
                model: preset.defaultModel,
              },
            },
          },
        });
        deps.conversationLoop?.refreshProvider?.();
        deps.rewireReviewerAgent?.();
        deps.refreshActiveLlmWildcard?.();
        // ASRT dynamic-endpoint union: the patch above sets the ollama vendor's
        // baseUrl, and the shared sandbox network union is derived from ALL
        // vendor baseUrls (settings.ts:40-43 invariant). Any vendor baseUrl
        // change — not just Foundry or the previously-active vendor — must
        // live-refresh the ASRT network config so the local Ollama endpoint host
        // is enforced/allowed without a restart. Guarded-optional + no-op when
        // the sandbox gate is OFF, matching settings.ts:230-232 / auth.ts:292-294.
        deps.refreshSandboxNetworkConfig?.();
      } catch (err) {
        log.error(`ollama activation failed: ${(err as Error).message}`);
        try {
          if (prevApiKey === null) {
            await deps.settingsService.deleteSecret(apiKeySecretKey);
          } else {
            await deps.settingsService.setSecret(apiKeySecretKey, prevApiKey);
          }
        } catch (rollbackErr) {
          log.error(`ollama secret rollback failed: ${(rollbackErr as Error).message}`);
        }
        try {
          await deps.settingsService.patch({ marketplace: prevMarketplace });
        } catch (rollbackErr) {
          log.error(`ollama marketplace rollback failed: ${(rollbackErr as Error).message}`);
        }
        try {
          await deps.settingsService.replaceLlm(prevLlm);
        } catch (rollbackErr) {
          log.error(`ollama LLM rollback failed: ${(rollbackErr as Error).message}`);
        }
        return { ok: false, error: "persist-failed" };
      }
      try {
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "auth",
          type: "info",
          input: "[demo-activation] activated vendor=ollama source=local-probe",
        });
      } catch { /* audit must not break IPC */ }
      log.info("ollama activation succeeded");
      return { ok: true, vendor: "ollama" };
    },
  );

  ipcMain.handle(
    CHANNELS.demo.clear,
    async (
      e,
    ): Promise<
      | { ok: true }
      | { ok: false; error: "clear-failed" | "unauthorized-frame" }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.demo.clear, e);
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
        // Write the demo-disabled sentinel FIRST, and make it load-bearing:
        // if it fails, the whole clear fails (`clear-failed`) and `.env.demo`
        // is left intact, so the persisted loader still owns hydration — the
        // demo stays active rather than silently resurrecting on the next
        // boot. Doing the sentinel after the `.env.demo` removal (or
        // swallowing its error) would be fail-OPEN: an IO failure would leave
        // neither file, and the embedded-key boot hydrate would re-activate a
        // session the user explicitly logged out of. A logout is an explicit
        // "stop using the demo" intent; the sentinel is its durable record,
        // honored by BOTH loadPersistedDemoActivationSync and
        // loadEmbeddedDemoActivationSync. The next activation removes it.
        await writeEnvDemoFile(demoDisabledSentinelPath(), "");
        const envDemoPath = persistedEnvDemoPath();
        await fs.rm(envDemoPath, { force: true });
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
    CHANNELS.auth.logoutBroadcast,
    async (
      e,
    ): Promise<
      | { ok: true }
      | { ok: false; error: "unauthorized-frame" }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.auth.logoutBroadcast, e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      broadcastAuthEvent(deps, AUTH_LOGOUT_RESET_CHANNEL);
      return { ok: true };
    },
  );

  ipcMain.handle(
    CHANNELS.auth.reactivateBroadcast,
    async (
      e,
    ): Promise<
      | { ok: true }
      | { ok: false; error: "unauthorized-frame" }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.auth.reactivateBroadcast, e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      broadcastAuthEvent(deps, AUTH_REACTIVATE_DEMO_CHANNEL);
      return { ok: true };
    },
  );

  ipcMain.handle(
    CHANNELS.demo.relaunchAfterActivation,
    async (
      e,
    ): Promise<
      | { ok: true }
      | { ok: false; error: "not-armed" | "unauthorized-frame" }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.demo.relaunchAfterActivation, e);
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
