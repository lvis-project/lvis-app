



import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import { createLogger } from "../../lib/logger.js";
import { getIsPackaged } from "../../boot/dev-flags.js";
import {
  getDemoActiveVendor,
  getDemoCredentials,
  getDemoHostMap,
  getDemoHostSubnet,
  getDemoVendorConfig,
  isDemoEnabled,
} from "../../main/demo-credentials.js";
import { validateDemoFoundryHostMap } from "../../main/demo-host-resolver.js";
import { validateFoundryEndpoint } from "../../permissions/reviewer/provider-adapters.js";
import { LoginProgressEmitter } from "../../main/login-progress-emitter.js";
import { isMarketplaceEligibleLLMVendor } from "../../shared/llm-vendor-defaults.js";
import type { IpcDeps } from "../types.js";
import type { LLMSettings } from "../../data/settings-store.js";

/**
 * Stable signature of EVERY vendor block's configured `baseUrl` (order-stable
 * by vendor id). Used to detect a baseUrl change across the login-mockup patch
 * and trigger `refreshSandboxNetworkConfig` if a vendor endpoint changed.
 * Mirrors the same helper in settings.ts — kept local so auth.ts has no
 * cross-domain import dependency on settings.ts.
 */
function vendorBaseUrlSignature(llm: LLMSettings): string {
  const vendors = llm.vendors ?? {};
  return Object.keys(vendors)
    .sort()
    .map((id) => `${id}=${vendors[id as keyof typeof vendors]?.baseUrl ?? ""}`)
    .join("|");
}

/**
 * #1498 — network-unreachable classification for the `sandbox-preparing`
 * failure path. Same detection regex as `classifyProviderError`'s
 * `"network"` category (`src/engine/llm/error-classifier.ts`) — reused
 * rather than re-derived so the two call sites can't drift on what counts
 * as "unreachable".
 *
 * Scoped to `azure-foundry` at the call site (not here): it is currently
 * the only demo vendor with an internal-network-only endpoint, so it's the
 * only vendor whose rewire failure is plausibly "VPN not connected" rather
 * than a genuine configuration/credential problem. Other vendors keep the
 * existing `reviewer-rewire-failed` code.
 */
function isEndpointUnreachableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /fetch|econnrefused|enotfound|etimedout|timeout/i.test(message);
}

const log = createLogger("auth-ipc");

const DEFAULT_DEMO_USER = "demo";
const DEFAULT_DEMO_PASS = "demo123";

/**
 * Translate a vendor id (kebab-case, e.g. `azure-foundry`) into the env-var
 * suffix the demo key reader looks for (`AZURE_FOUNDRY`). Single point of
 * convention so renderer + IPC stay in lockstep.
 */
export function demoKeyEnvVar(vendor: string): string {
  return `LVIS_DEMO_KEY_${vendor.toUpperCase().replace(/-/g, "_")}`;
}

function marketplaceInstallPatchForDemoVendor(
  settingsService: IpcDeps["settingsService"],
  vendor: string,
) {
  if (!isMarketplaceEligibleLLMVendor(vendor)) return {};
  const installedProviderIds =
    settingsService.get("marketplace").installedProviderIds ?? [];
  return {
    marketplace: {
      installedProviderIds: installedProviderIds.includes(vendor)
        ? installedProviderIds
        : [...installedProviderIds, vendor],
    },
  };
}

export function registerAuthHandlers(deps: IpcDeps): void {
  const { settingsService, auditLogger } = deps;

  // PR #894 B1 — Production safety gate. In packaged builds the mockup
  // login handler must not register unless `isDemoEnabled()` is true
  // (i.e. `captureDemoCredentials()` saw a non-empty `LVIS_DEMO_KEY_*`
  // set pre-scrub). Dev builds always register so local engineering still
  // has the demo loop.
  if (getIsPackaged() && !isDemoEnabled()) {
    log.info("mockup login handler skipped (production build, no demo activation captured)");
    return;
  }

  // Tutorial-X1 — broadcasts step-by-step progress on `lvis:auth:progress`
  // so the LoginModal checklist tracks the *real* main-process steps
  // instead of a renderer setTimeout illusion. The getAppWindows accessor
  // gracefully degrades when neither accessor is wired (e.g. test
  // harnesses pass minimal deps): an empty array means the broadcast is
  // a no-op while the audit row still fires.
  const progress = new LoginProgressEmitter(
    () => {
      const fromAll = deps.getAppWindows?.();
      if (Array.isArray(fromAll)) return fromAll;
      const main = deps.getMainWindow?.();
      return main ? [main] : [];
    },
    auditLogger,
  );

  ipcMain.handle(
    CHANNELS.auth.loginMockup,
    async (
      e,
      payload: { username?: unknown; password?: unknown },
    ): Promise<
      | {
          ok: true;
          vendor: string;
          model?: string;
          baseUrl?: string;
          vertexProject?: string;
          vertexLocation?: string;
          fieldsApplied: string[];
        }
      | { ok: false; error: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.auth.loginMockup, e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }

      const username = typeof payload?.username === "string" ? payload.username : "";
      const password = typeof payload?.password === "string" ? payload.password : "";

      // #893 top-level login — vendor is decided by the backend
      // (captured LVIS_DEMO_VENDOR env, default "azure-foundry"), not by the renderer.
      const vendor = getDemoActiveVendor();

      // Step 1 — credentials-validating. Emits `running` before the
      // expected-user comparison, then `done` after a successful match.
      // A mismatch reports `failed` + the matching IPC error code so the
      // renderer's checklist shows the X mark on the right row.
      progress.emit({ step: "credentials-validating", status: "running" });
      const overrides = getDemoCredentials();
      const expectedUser = overrides.user ?? DEFAULT_DEMO_USER;
      const expectedPass = overrides.pass ?? DEFAULT_DEMO_PASS;
      if (username !== expectedUser || password !== expectedPass) {
        progress.fail("credentials-validating", "invalid-credentials");
        try {
          auditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "auth",
            type: "warn",
            input: `login_mockup_denied vendor=${vendor}`,
          });
        } catch { /* audit must not break IPC */ }
        return { ok: false, error: "invalid-credentials" };
      }
      progress.emit({ step: "credentials-validating", status: "done" });

      const demoConfig = getDemoVendorConfig(vendor);
      if (demoConfig === null) {
        progress.fail("llm-key-issuing", "no-demo-key", vendor);
        return { ok: false, error: "no-demo-key" };
      }
      if (vendor === "azure-foundry") {
        if (typeof demoConfig.baseUrl !== "string" || demoConfig.baseUrl.length === 0) {
          progress.fail("llm-key-issuing", "missing-foundry-endpoint", vendor);
          log.warn("loginMockup missing azure-foundry baseUrl");
          return { ok: false, error: "missing-foundry-endpoint" };
        }
        try {
          validateFoundryEndpoint(demoConfig.baseUrl);
        } catch (err) {
          progress.fail("llm-key-issuing", "invalid-foundry-endpoint", vendor);
          log.warn(
            `loginMockup invalid azure-foundry baseUrl: ${(err as Error).message}`,
          );
          return { ok: false, error: "invalid-foundry-endpoint" };
        }
        const hostMapError = validateDemoFoundryHostMap(
          demoConfig.baseUrl,
          getDemoHostMap(),
          getDemoHostSubnet(),
        );
        if (hostMapError !== null) {
          progress.fail("llm-key-issuing", hostMapError, vendor);
          log.warn(`loginMockup invalid azure-foundry host map: ${hostMapError}`);
          return { ok: false, error: hostMapError };
        }
      }

      const fieldsApplied: string[] = ["apiKey"];

      // Step 2 — llm-key-issuing. Encapsulates the secret-store write +
      // top-level settings patch so the renderer sees "키 발급" run until
      // the persistent state is durable on disk.
      //
      // v0.2.1 hotfix — wrap in try/catch so disk / Keychain failures
      // emit `llm-key-issuing-failed` instead of bubbling as an IPC
      // promise rejection. This is the user-visible "sandbox 준비 중"
      // failure path the renderer transcript was hitting on first boot.
      const apiKeySecretKey = `llm.apiKey.${vendor}`;
      const prevApiKey = settingsService.getSecret(apiKeySecretKey);
      const prevLlm = settingsService.get("llm");
      const prevMarketplace = settingsService.get("marketplace");
      try {
        await progress.runStep(
          "llm-key-issuing",
          async () => {
            await settingsService.setSecret(apiKeySecretKey, demoConfig.apiKey);

            // Build vendor settings patch for optional fields (baseUrl / model
            // / vertex). Only apply fields the demo config actually provides
            // so apiKey-only login still works as before.
            const vendorPatch: Record<string, unknown> = {};
            if (demoConfig.baseUrl !== undefined) {
              vendorPatch.baseUrl = demoConfig.baseUrl;
              fieldsApplied.push("baseUrl");
            }
            if (demoConfig.model !== undefined) {
              vendorPatch.model = demoConfig.model;
              fieldsApplied.push("model");
            }
            if (demoConfig.vertexProject !== undefined) {
              vendorPatch.vertexProject = demoConfig.vertexProject;
              fieldsApplied.push("vertexProject");
            }
            if (demoConfig.vertexLocation !== undefined) {
              vendorPatch.vertexLocation = demoConfig.vertexLocation;
              fieldsApplied.push("vertexLocation");
            }
            // #893 — single combined patch: flip top-level authMode + provider
            // AND apply the active vendor's optional config block.
            await settingsService.patch({
              ...marketplaceInstallPatchForDemoVendor(settingsService, vendor),
              llm: {
                authMode: "login",
                provider: vendor,
                ...(Object.keys(vendorPatch).length > 0
                  ? { vendors: { [vendor]: vendorPatch } }
                  : {}),
              },
            });
          },
          vendor,
        );
      } catch (err) {
        // setSecret / patch failed — secret store may have a partial
        // write. Best-effort restore prevents the next login attempt
        // from inheriting a half-applied key.
        //
        // v0.2.1 hotfix — main-process log.error so the failure stack
        // lands in `~/Library/Logs/LVIS/main.log` (macOS) /
        // `%APPDATA%/LVIS/logs/main.log` (Windows) for user-driven
        // support escalations.
        log.error(
          `loginMockup llm-key-issuing failed: ${(err as Error).message}`,
        );
        try {
          if (prevApiKey === null) {
            await settingsService.deleteSecret(apiKeySecretKey);
          } else {
            await settingsService.setSecret(apiKeySecretKey, prevApiKey);
          }
        } catch (rollbackErr) {
          log.error(
            `loginMockup secret rollback failed: ${(rollbackErr as Error).message}`,
          );
        }
        try {
          await settingsService.patch({ marketplace: prevMarketplace });
        } catch (rollbackErr) {
          log.error(
            `loginMockup marketplace rollback failed: ${(rollbackErr as Error).message}`,
          );
        }
        try {
          await settingsService.replaceLlm(prevLlm);
        } catch (rollbackErr) {
          // Rollback itself failed (e.g. Keychain unavailable). The
          // outer return below preserves the IPC contract; the user
          // will see the actionable Korean toast and can retry.
          log.error(
            `loginMockup llm-key-issuing rollback failed: ${(rollbackErr as Error).message}`,
          );
        }
        return { ok: false, error: "llm-key-issuing-failed" };
      }

      // Step 3 — sandbox-preparing. Captures the reviewer-agent rewire +
      // provider refresh so the user sees the agent sandbox spin up. On
      // rewire failure we roll the settings store back to its prior state
      // and report `reviewer-rewire-failed`.
      //
      // ASRT choke-point: the llm-key-issuing step above may have patched a
      // vendor baseUrl (when demoConfig.baseUrl is set). Capture the signature
      // AFTER that patch completes so the sandbox live-refresh fires here if
      // any vendor endpoint changed, matching the settings:update choke-point.
      const postPatchLlm = settingsService.get("llm");
      const postPatchVendorSig = vendorBaseUrlSignature(postPatchLlm);
      const prevVendorSig = vendorBaseUrlSignature(prevLlm);
      try {
        await progress.runStep(
          "sandbox-preparing",
          async () => {
            // #893 — refresh plugin wildcard so a plugin's next
            // `hostApi.config.get("hostApiKey")` observes the newly-installed
            // key without an app restart. Reviewer wiring follows the active
            // chat provider/model, so this login path must rewire through
            // the same closure as settings:update.
            deps.rewireReviewerAgent?.();
            // ASRT sandbox choke-point: when the login patch included a vendor
            // baseUrl change, live-refresh the ASRT shared network union so the
            // new endpoint host is enforced immediately (no restart required).
            // No-op when the sandbox gate is OFF or no baseUrl changed.
            if (postPatchVendorSig !== prevVendorSig) {
              deps.refreshSandboxNetworkConfig?.();
            }
          },
          vendor,
        );
      } catch (err) {
        // v0.2.1 hotfix — wrap the rollback inner in try/catch so a
        // partial-rollback failure (e.g. Keychain unavailable during
        // restore) still resolves to `reviewer-rewire-failed` rather
        // than throwing through the IPC channel. The renderer's
        // transcript depends on the contract that this handler always
        // returns `{ok:false, error}` on failure paths.
        //
        // Main-process log.error so the failure stack lands in the
        // user-visible log file for support escalations.
        log.error(
          `loginMockup sandbox-preparing failed: ${(err as Error).message}`,
        );
        try {
          await settingsService.patch({ marketplace: prevMarketplace });
        } catch (rollbackErr) {
          log.error(
            `loginMockup marketplace rollback failed: ${(rollbackErr as Error).message}`,
          );
        }
        try {
          await settingsService.replaceLlm(prevLlm);
        } catch (rollbackErr) {
          // Partial settings rollback — the persisted on-disk state may
          // still reflect the new vendor. The user can re-login or
          // restart; either path heals the state.
          log.error(
            `loginMockup replaceLlm rollback failed: ${(rollbackErr as Error).message}`,
          );
        }
        try {
          if (prevApiKey === null) {
            await settingsService.deleteSecret(apiKeySecretKey);
          } else {
            await settingsService.setSecret(apiKeySecretKey, prevApiKey);
          }
        } catch (rollbackErr) {
          // Secret-store rollback failed. Same observation as above —
          // re-login or restart heals.
          log.error(
            `loginMockup secret rollback failed: ${(rollbackErr as Error).message}`,
          );
        }
        try {
          deps.rewireReviewerAgent?.();
        } catch (rewireErr) {
          // Rolled back to the previous active LLM settings. Keep returning
          // the machine-readable error so the renderer can surface retry UI.
          log.error(
            `loginMockup post-rollback rewire failed: ${(rewireErr as Error).message}`,
          );
        }
        deps.conversationLoop?.refreshProvider?.();
        deps.refreshActiveLlmWildcard?.();
        // #1498 — Azure Foundry's endpoint is internal-network-only (the
        // whole embedded-activation safety model depends on that boundary).
        // A relaunch that still can't reach it (VPN/intranet not connected)
        // previously surfaced as the generic `reviewer-rewire-failed`,
        // which gave the user no actionable signal. The renderer already
        // has a Korean "check your VPN" mapping for `endpoint-unreachable`
        // (LoginModalConversational's `errorMessage`) — it just never had a
        // producer. Scoped to azure-foundry: other vendors' rewire
        // failures are not plausibly a network-boundary issue.
        if (vendor === "azure-foundry" && isEndpointUnreachableError(err)) {
          return { ok: false, error: "endpoint-unreachable" };
        }
        return { ok: false, error: "reviewer-rewire-failed" };
      }
      deps.conversationLoop?.refreshProvider?.();
      deps.refreshActiveLlmWildcard?.();
      try {
        // PR #894 T1-10 — `keySource=<envVar>` previously leaked the exact
        // env var name (`LVIS_DEMO_KEY_OPENAI`) into the audit log, giving
        // an attacker who scraped audit JSONL the namespace to enumerate.
        // The fingerprint is "demo key was present"; the env var name is
        // not load-bearing for forensics, so redact to `present`.
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "auth",
          type: "info",
          input: `login_mockup_ok vendor=${vendor} keySource=present fields=${fieldsApplied.join(",")}`,
        });
      } catch { /* audit must not break IPC */ }

      // Step 4 — terminal `complete` event. Lets the renderer collapse the
      // checklist + hide the spinner once every step has settled.
      progress.complete(vendor);

      const response: {
        ok: true;
        vendor: string;
        model?: string;
        baseUrl?: string;
        vertexProject?: string;
        vertexLocation?: string;
        fieldsApplied: string[];
      } = { ok: true, vendor, fieldsApplied };
      if (demoConfig.model !== undefined) response.model = demoConfig.model;
      if (demoConfig.baseUrl !== undefined) response.baseUrl = demoConfig.baseUrl;
      if (demoConfig.vertexProject !== undefined) response.vertexProject = demoConfig.vertexProject;
      if (demoConfig.vertexLocation !== undefined) response.vertexLocation = demoConfig.vertexLocation;
      return response;
    },
  );
}
