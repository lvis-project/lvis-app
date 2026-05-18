/**
 * Auth domain IPC handlers (#893).
 *
 * Mockup login flow. Hard-coded demo credentials (`demo` / `demo123`) gate
 * an env-var-sourced API key handoff into the encrypted secret store. The
 * mockup is intentionally minimal — production SSO/OAuth is out of scope
 * for this PR and lives in the plugin-owned auth path.
 *
 * Top-level login (#893):
 *   The renderer no longer sends a `vendor` — Login wraps vendor selection.
 *   The backend reads `LVIS_DEMO_VENDOR` (default `"openai"`) via
 *   `getDemoActiveVendor()`, persists the matching key, applies the full
 *   vendor config (baseUrl / model / vertex), and flips top-level settings
 *   `authMode = "login"` + `provider = <vendor>` in a single patch so the
 *   UI lands on the now-active vendor with manual fields hidden.
 *
 * Error contract (CLAUDE.md):
 *   - IPC `error` codes are kebab-case English (machine-readable).
 *   - User-facing Korean text is the renderer's responsibility — never
 *     embedded in the IPC payload.
 *
 * Production gate (PR #894 review B1):
 *   - Demo credentials live in `LVIS_DEMO_*` env vars captured at boot,
 *     then scrubbed from `process.env`. In packaged builds, the handler
 *     refuses to register unless `LVIS_DEMO_ENABLED=1` was set at boot.
 *   - This prevents a shipped binary from accepting the literal `demo` /
 *     `demo123` mockup credentials and persisting an attacker-controlled
 *     "demo" key under `llm.apiKey.<vendor>`.
 *
 * Credential override:
 *   `LVIS_DEMO_USER` / `LVIS_DEMO_PASS` — let local dev rotate the demo
 *   credentials without rebuilding. Production builds rely on the defaults.
 *
 * Key sourcing:
 *   `LVIS_DEMO_KEY_<VENDOR_UPPER_WITH_UNDERSCORES>` — when present, the
 *   handler stores its value under `llm.apiKey.<vendor>` via
 *   `settingsService.setSecret(...)`. When absent, the handler returns
 *   `error: "no-demo-key"` so the renderer can fall through to manual
 *   entry without silently appearing to succeed.
 */
import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { createLogger } from "../../lib/logger.js";
import { getIsPackaged } from "../../boot/dev-flags.js";
import {
  getDemoActiveVendor,
  getDemoCredentials,
  getDemoVendorConfig,
  isDemoEnabled,
} from "../../main/demo-credentials.js";
import type { IpcDeps } from "../types.js";

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

export function registerAuthHandlers(deps: IpcDeps): void {
  const { settingsService, auditLogger } = deps;

  // PR #894 B1 — Production safety gate. In packaged builds the mockup
  // login handler must not register unless `LVIS_DEMO_ENABLED=1` was set
  // at boot (captured pre-scrub). Dev builds always register so local
  // engineering still has the demo loop.
  if (getIsPackaged() && !isDemoEnabled()) {
    log.info("mockup login handler skipped (production build, LVIS_DEMO_ENABLED unset)");
    return;
  }

  ipcMain.handle(
    "lvis:auth:login-mockup",
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
        auditUnauthorized(auditLogger, "lvis:auth:login-mockup", e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }

      const username = typeof payload?.username === "string" ? payload.username : "";
      const password = typeof payload?.password === "string" ? payload.password : "";

      // #893 top-level login — vendor is decided by the backend
      // (LVIS_DEMO_VENDOR env, default "openai"), not by the renderer.
      const vendor = getDemoActiveVendor();

      const overrides = getDemoCredentials();
      const expectedUser = overrides.user ?? DEFAULT_DEMO_USER;
      const expectedPass = overrides.pass ?? DEFAULT_DEMO_PASS;
      if (username !== expectedUser || password !== expectedPass) {
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

      const demoConfig = getDemoVendorConfig(vendor);
      if (demoConfig === null) {
        return { ok: false, error: "no-demo-key" };
      }

      const fieldsApplied: string[] = ["apiKey"];

      // Persist the API key into the encrypted secret store.
      await settingsService.setSecret(`llm.apiKey.${vendor}`, demoConfig.apiKey);
      const prevLlm = settingsService.get("llm");

      // Build vendor settings patch for optional fields (baseUrl / model / vertex).
      // Only apply fields that the demo config actually provides — this ensures
      // that when a demo env var is absent, existing user-entered values are
      // preserved (backward compat: apiKey-only login still works as before).
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

      // #893 — single combined patch: flip top-level authMode + provider AND
      // apply the active vendor's optional config block. The settings store's
      // mergeLlmPatch leaves other vendors untouched.
      await settingsService.patch({
        llm: {
          authMode: "login",
          provider: vendor,
          ...(Object.keys(vendorPatch).length > 0
            ? { vendors: { [vendor]: vendorPatch } }
            : {}),
        },
      });

      // #893 — refresh plugin wildcard so a plugin's next `hostApi.config.get
      // ("hostApiKey")` observes the newly-installed key without an app
      // restart. Reviewer wiring follows the active chat provider/model, so
      // this login path must rewire through the same closure as settings:update.
      try {
        deps.rewireReviewerAgent?.();
      } catch {
        await settingsService.patch({ llm: prevLlm });
        try {
          deps.rewireReviewerAgent?.();
        } catch {
          // Rolled back to the previous active LLM settings. Keep returning
          // the machine-readable error so the renderer can surface retry UI.
        }
        deps.conversationLoop?.refreshProvider?.();
        deps.refreshActiveLlmWildcard?.();
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
