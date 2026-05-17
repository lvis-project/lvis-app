/**
 * Auth domain IPC handlers (#893).
 *
 * Mockup login flow. Hard-coded demo credentials (`demo` / `demo123`) gate
 * an env-var-sourced API key handoff into the encrypted secret store. The
 * mockup is intentionally minimal — production SSO/OAuth is out of scope
 * for this PR and lives in the plugin-owned auth path.
 *
 * Error contract (CLAUDE.md):
 *   - IPC `error` codes are kebab-case English (machine-readable).
 *   - User-facing Korean text is the renderer's responsibility — never
 *     embedded in the IPC payload.
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
import { isLLMVendor } from "../../shared/llm-vendor-defaults.js";
import type { IpcDeps } from "../types.js";

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

  ipcMain.handle(
    "lvis:auth:login-mockup",
    async (
      e,
      payload: { username?: unknown; password?: unknown; vendor?: unknown },
    ): Promise<
      | { ok: true; vendor: string }
      | { ok: false; error: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:auth:login-mockup", e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }

      const username = typeof payload?.username === "string" ? payload.username : "";
      const password = typeof payload?.password === "string" ? payload.password : "";
      const vendor = typeof payload?.vendor === "string" ? payload.vendor : "";

      if (!isLLMVendor(vendor)) {
        return { ok: false, error: "invalid-vendor" };
      }

      const expectedUser = process.env.LVIS_DEMO_USER ?? DEFAULT_DEMO_USER;
      const expectedPass = process.env.LVIS_DEMO_PASS ?? DEFAULT_DEMO_PASS;
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

      const envVar = demoKeyEnvVar(vendor);
      const apiKey = process.env[envVar];
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        return { ok: false, error: "no-demo-key" };
      }

      await settingsService.setSecret(`llm.apiKey.${vendor}`, apiKey);
      // #893 — refresh plugin wildcard so a plugin's next `hostApi.config.get
      // ("hostApiKey")` observes the newly-installed key without an app
      // restart. The reviewer is rewired by the same closure path the
      // settings IPC handler uses; keeping the helper optional so unit tests
      // that don't wire the AppServices bag stay simple.
      deps.refreshActiveLlmWildcard?.();
      try {
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "auth",
          type: "info",
          input: `login_mockup_ok vendor=${vendor} keySource=${envVar}`,
        });
      } catch { /* audit must not break IPC */ }
      return { ok: true, vendor };
    },
  );
}
