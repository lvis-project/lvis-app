// Named imports — esbuild bundles these as direct property access on the CJS
// module (no `__toESM` wrapper, no `.default` indirection). Aligned with
// plugin-preload.ts for the same reason: Electron 41 sandboxed webview preload
// contexts fail silently when the bundled output goes through
// `__toESM(require("electron"), 1).default.contextBridge`.
import { contextBridge, ipcRenderer } from "electron";
import { randomUUID } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
import { t } from "./i18n/index.js";
import type { McpServerConfig } from "./mcp/types.js";
import type {
  UserApprovalHitPayload,
  UserApprovalScope,
  UserApprovalVerdict,
} from "./shared/permissions-events.js";
import type { SerializedHistoryMessage } from "./shared/chat-history.js";
import type { StreamEvent } from "./lib/chat-stream-state.js";
import { MARKETPLACE, OVERLAY_V1, PERMISSIONS, ROUTINES_V2, SETTINGS, UI } from "./shared/ipc-channels.js";
import type { MarketplaceAnnouncementPayload } from "./shared/marketplace-announcements.js";
import { PLUGIN_PRIVATE_NAMESPACES } from "./plugins/capabilities.js";
import type {
  ChatSendInputOrigin,
  UserKeyboardIntent,
  UserKeyboardIntentSnapshot,
} from "./shared/chat-origin.js";
import type {
  AssistantContextMenuAction,
  AssistantContextMenuPayload,
} from "./shared/assistant-context-menu.js";
import type { AiProviderPingIpcResult } from "./shared/ai-provider-ping.js";
import type {
  OpenHtmlPreviewWindowPayload,
  OpenHtmlPreviewWindowResult,
} from "./shared/render-html-preview.js";
import type { SessionTodoItem } from "./shared/session-todo.js";

// ─── Deterministic plugin webview asset URLs ────────────────────────────────
// `__dirname` here resolves to the host preload's bundled location
// (`dist/src/`). Compute the plugin shell + preload URLs once on preload boot
// instead of deriving them from `window.location.href`, which can be the
// splash phase's `data:text/html;...` URL when the host renderer queries it.
// Producing `file://` strings means Electron always finds the assets even
// across reloads / drag-drop / dev-mode navigation.
function safeResolveFileUrl(relative: string): string {
  try {
    return pathToFileURL(pathResolve(__dirname, relative)).toString();
  } catch {
    return "";
  }
}
const pluginPreloadUrl = safeResolveFileUrl("plugin-preload.cjs");
const pluginShellUrl = safeResolveFileUrl("plugin-ui-shell.html");

// ─── Theme race-window-zero prime ───────────────────────────────────────────
// Main process passes the host's currently cached `lastThemePayload` to every
// new BrowserWindow via `webPreferences.additionalArguments` so that:
//   (1) tokens are applied to documentElement BEFORE React mounts (frame-0
//       paint correct — no flash of fallback CSS on the first render),
//   (2) ThemeProvider can read the same payload via `window.__lvisInitialTheme`
//       and skip its async settings.json hydrate, eliminating the cold-boot
//       race where detached windows registered a plugin webview before
//       the renderer's first `notifyPluginTheme` broadcast.
// See main.ts:initialThemeArgs for the matching startup payload.
//
// PREFIX, payload shape, and size cap are shared with main.ts via
// `src/shared/initial-theme.ts` so the wire format has a single SoT.
import {
  INITIAL_THEME_ARG_PREFIX,
  INITIAL_THEME_ARG_MAX_BYTES,
  type InitialThemePrime,
} from "./shared/initial-theme.js";

type LvisInitialThemePayload = Readonly<InitialThemePrime>;

function readInitialThemeArg(): LvisInitialThemePayload | null {
  try {
    // `findLast` (vs `find`) defends against accidental duplicate arg
    // injection: if anyone ever passes the prefix twice, the later one wins
    // — matching the convention that "last write wins" in argv-style flags.
    const arg = process.argv.findLast(
      (a): a is string => typeof a === "string" && a.startsWith(INITIAL_THEME_ARG_PREFIX),
    );
    if (!arg) return null;
    const json = arg.slice(INITIAL_THEME_ARG_PREFIX.length);
    // Size guard mirrors `main.ts:initialThemeArgs` — keeps a malformed or
    // attacker-influenced argv from blocking the renderer on a giant parse.
    if (json.length > INITIAL_THEME_ARG_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as { bundleId?: unknown; shell?: unknown; tokens?: unknown };
    if (typeof p.bundleId !== "string") return null;
    if (p.shell !== "light" && p.shell !== "dark") return null;
    const tokens: Record<string, string> = {};
    if (p.tokens && typeof p.tokens === "object" && !Array.isArray(p.tokens)) {
      for (const [k, v] of Object.entries(p.tokens as Record<string, unknown>)) {
        if (typeof k === "string" && k.startsWith("--lvis-") && typeof v === "string") {
          tokens[k] = v;
        }
      }
    }
    return Object.freeze({ bundleId: p.bundleId, shell: p.shell, tokens: Object.freeze(tokens) });
  } catch {
    return null;
  }
}

const lvisInitialTheme = readInitialThemeArg();

if (lvisInitialTheme && typeof document !== "undefined") {
  // Apply attributes + tokens immediately. Preload's mutations to
  // documentElement are visible to the renderer's first paint because both
  // share the same DOM (contextIsolation isolates JS objects, not DOM).
  try {
    const root = document.documentElement;
    root.setAttribute("data-theme-bundle", lvisInitialTheme.bundleId);
    root.setAttribute("data-shell", lvisInitialTheme.shell);
    if (lvisInitialTheme.tokens) {
      for (const [k, v] of Object.entries(lvisInitialTheme.tokens)) {
        root.style.setProperty(k, v);
      }
    }
  } catch {
    // Non-fatal: ThemeProvider's async hydrate still runs as a fallback.
  }
}

type PluginActionResult =
  | { ok: true; pluginId: string; installed?: true; uninstalled?: true; version?: string }
  | { ok: false; error: string; message?: string };

function invalidPluginActionResult(): PluginActionResult {
  return {
    ok: false,
    error: "invalid-result",
    message: t("be_preload.invalidPluginActionResult"),
  };
}

function normalizePluginActionResult(result: unknown): PluginActionResult {
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    return result as PluginActionResult;
  }

  const payload = result && typeof result === "object"
    ? result as { pluginId?: unknown; installed?: unknown; uninstalled?: unknown; version?: unknown }
    : {};
  const pluginId = typeof payload.pluginId === "string" ? payload.pluginId.trim() : "";
  const installed = payload.installed === true;
  const uninstalled = payload.uninstalled === true;
  if (!pluginId || (!installed && !uninstalled)) {
    return invalidPluginActionResult();
  }
  const normalized: PluginActionResult = {
    ok: true,
    pluginId,
  };
  if (installed) {
    normalized.installed = true;
  }
  if (uninstalled) {
    normalized.uninstalled = true;
  }
  if (typeof payload.version === "string") {
    normalized.version = payload.version;
  }
  return normalized;
}

function normalizeMarketplacePackageActionResult(
  result: unknown,
  idField: "agentId" | "skillId",
): PluginActionResult {
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    return result as PluginActionResult;
  }
  const payload = result && typeof result === "object"
    ? result as Record<string, unknown>
    : {};
  const packageId = typeof payload[idField] === "string" ? payload[idField].trim() : "";
  if (!packageId) return invalidPluginActionResult();
  const normalized: PluginActionResult = { ok: true, pluginId: packageId };
  if (payload.uninstalled === true) normalized.uninstalled = true;
  else normalized.installed = true;
  if (typeof payload.version === "string") normalized.version = payload.version;
  return normalized;
}

function hasActiveUserGesture(): boolean {
  return globalThis.navigator?.userActivation?.isActive === true;
}

const USER_KEYBOARD_INTENT_TTL_MS = 5_000;
const userKeyboardIntentTokens = new Map<string, number>();

function pruneExpiredUserKeyboardIntents(now = Date.now()): void {
  for (const [token, expiresAt] of userKeyboardIntentTokens) {
    if (expiresAt <= now) userKeyboardIntentTokens.delete(token);
  }
}

function captureUserKeyboardIntent(): UserKeyboardIntentSnapshot {
  if (!hasActiveUserGesture()) {
    return { inputOrigin: "user-keyboard", token: "" };
  }
  const now = Date.now();
  pruneExpiredUserKeyboardIntents(now);
  const token = randomUUID();
  userKeyboardIntentTokens.set(token, now + USER_KEYBOARD_INTENT_TTL_MS);
  return { inputOrigin: "user-keyboard", token };
}

function consumeUserKeyboardIntent(userIntent?: UserKeyboardIntentSnapshot): boolean {
  const activeGesture = hasActiveUserGesture();
  if (userIntent && userIntent.inputOrigin === "user-keyboard" && typeof userIntent.token === "string") {
    const expiresAt = userKeyboardIntentTokens.get(userIntent.token);
    userKeyboardIntentTokens.delete(userIntent.token);
    if (typeof expiresAt === "number" && expiresAt > Date.now()) return true;
  }
  return activeGesture;
}

function ipcUserKeyboardIntent(): UserKeyboardIntent | { inputOrigin: "user-keyboard"; userActivation: false } {
  return {
    inputOrigin: "user-keyboard",
    userActivation: hasActiveUserGesture(),
  };
}

const api = {
  // ─── Plugin webview asset URLs (deterministic file://) ────────────────────
  // Static strings, NOT functions — the host renderer reads these directly
  // when mounting the plugin <webview>. Computed once at preload boot from
  // `__dirname` (= dist/src/) so they survive splash-phase data: URLs.
  pluginPreloadUrl,
  pluginShellUrl,

  // ─── Settings ────────────────────────────────────
  getSettings: async () => ipcRenderer.invoke("lvis:settings:get"),
  updateSettings: async (partial: unknown) => ipcRenderer.invoke("lvis:settings:update", partial),
  applyHostMap: async (hostResolverMap: string) => ipcRenderer.invoke(SETTINGS.applyHostMap, hostResolverMap),
  onSettingsUpdated: (handler: (settings: unknown) => void) => {
    const listener = (_event: unknown, settings: unknown) => handler(settings);
    ipcRenderer.on(SETTINGS.updated, listener);
    return () => ipcRenderer.removeListener(SETTINGS.updated, listener);
  },
  setApiKey: async (vendor: string, apiKey: string) => ipcRenderer.invoke("lvis:settings:set-api-key", vendor, apiKey),
  hasApiKey: async (vendor?: string) => ipcRenderer.invoke("lvis:settings:has-api-key", vendor) as Promise<boolean>,
  deleteApiKey: async (vendor: string) => ipcRenderer.invoke("lvis:settings:delete-api-key", vendor),
  setWebApiKey: async (provider: string, apiKey: string) => ipcRenderer.invoke("lvis:settings:set-web-api-key", provider, apiKey),
  hasWebApiKey: async (provider: string) => ipcRenderer.invoke("lvis:settings:has-web-api-key", provider) as Promise<boolean>,
  deleteWebApiKey: async (provider: string) => ipcRenderer.invoke("lvis:settings:delete-web-api-key", provider),
  setMarketplaceApiKey: async (apiKey: string) => ipcRenderer.invoke("lvis:settings:marketplace:set-api-key", apiKey),
  hasMarketplaceApiKey: async () => ipcRenderer.invoke("lvis:settings:marketplace:has-api-key") as Promise<boolean>,
  deleteMarketplaceApiKey: async () => ipcRenderer.invoke("lvis:settings:marketplace:delete-api-key"),
  // #893 — top-level mockup credential login. Hard-coded `demo`/`demo123`
  // (env override via `LVIS_DEMO_USER` / `LVIS_DEMO_PASS`). Vendor is no
  // longer sent by the renderer; the backend picks via `LVIS_DEMO_VENDOR`
  // (default `"openai"`) and reports it back on success along with the
  // applied baseUrl/model/vertex config.
  loginMockup: async (payload: { username: string; password: string }) =>
    ipcRenderer.invoke("lvis:auth:login-mockup", payload) as Promise<
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
    >,
  // Tutorial-X1 — Auth progress IPC. The host emits `lvis:auth:progress`
  // events at each real step of `loginMockup` (credentials-validating →
  // llm-key-issuing → sandbox-preparing → complete) so the LoginModal
  // checklist animates against actual main-process work instead of a
  // renderer `setTimeout` illusion. Channel is one-way (main → renderer);
  // each event payload is `{ step, status, vendor?, error? }` where
  // `step`/`status` are kebab-case English (CLAUDE.md error-language).
  auth: {
    onProgress: (
      handler: (event: {
        step: "credentials-validating" | "llm-key-issuing" | "sandbox-preparing" | "complete";
        status: "running" | "done" | "failed";
        vendor?: string;
        error?: string;
      }) => void,
    ) => {
      const validSteps = new Set([
        "credentials-validating",
        "llm-key-issuing",
        "sandbox-preparing",
        "complete",
      ]);
      const validStatuses = new Set(["running", "done", "failed"]);
      const listener = (
        _event: unknown,
        payload: {
          step?: unknown;
          status?: unknown;
          vendor?: unknown;
          error?: unknown;
        },
      ) => {
        const step = payload?.step;
        const status = payload?.status;
        if (typeof step !== "string" || !validSteps.has(step)) return;
        if (typeof status !== "string" || !validStatuses.has(status)) return;
        handler({
          step: step as
            | "credentials-validating"
            | "llm-key-issuing"
            | "sandbox-preparing"
            | "complete",
          status: status as "running" | "done" | "failed",
          ...(typeof payload?.vendor === "string" ? { vendor: payload.vendor } : {}),
          ...(typeof payload?.error === "string" ? { error: payload.error } : {}),
        });
      };
      ipcRenderer.on("lvis:auth:progress", listener);
      return () => ipcRenderer.removeListener("lvis:auth:progress", listener);
    },
    // 2026-05-20 — Settings 가 별도 BrowserWindow 로 mount 되기 때문에 main
    // window 의 onboarding chain / LoginModal 에 직접 dispatch 하지 못한다.
    // `broadcast*` 는 main 에서 모든 window 로 fan-out 하는 cue, `on*` 은
    // main window 의 App.tsx 가 subscribe 하는 listener. payload 가 없다.
    broadcastLogoutReset: async () =>
      ipcRenderer.invoke("lvis:auth:logout-broadcast") as Promise<
        | { ok: true }
        | { ok: false; error: "unauthorized-frame" }
      >,
    broadcastReactivateDemo: async () =>
      ipcRenderer.invoke("lvis:auth:reactivate-broadcast") as Promise<
        | { ok: true }
        | { ok: false; error: "unauthorized-frame" }
      >,
    onLogoutReset: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on("lvis:auth:logout-reset", listener);
      return () => ipcRenderer.removeListener("lvis:auth:logout-reset", listener);
    },
    onReactivateDemo: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on("lvis:auth:reactivate-demo", listener);
      return () => ipcRenderer.removeListener("lvis:auth:reactivate-demo", listener);
    },
  },
  /**
   * Demo activation bridge. `status` reads main's captured demo state after
   * packaged env scrub. `activate` receives a pasted `LVIS-DEMO:v1:<...>`
   * activation string, decrypts it back into the original `.env.demo`
   * payload, persists it under `~/.lvis/secrets/.env.demo` (0o600), and
   * re-runs the demo-credentials capture. First activation then relaunches;
   * a later chip 1 click sees `status.activated=true` and invokes
   * `loginMockup`.
   *
   * Error codes (kebab-case English per CLAUDE.md):
   *   - `invalid-code`     bad prefix, corrupt base64, auth-tag mismatch,
   *                        or empty input.
   *   - `no-vendor`        decrypted payload missing `LVIS_DEMO_VENDOR`.
   *   - `invalid-vendor`   decrypted payload has an unknown `LVIS_DEMO_VENDOR`.
   *   - `no-demo-key`      decrypted payload missing the active vendor key.
   *   - `missing-foundry-endpoint` Azure Foundry endpoint missing.
   *   - `invalid-foundry-endpoint` Azure Foundry endpoint rejected by the
   *                        shared endpoint validator.
   *   - `missing-foundry-host-map` Azure Foundry private endpoint host map missing.
   *   - `foundry-host-map-mismatch` Azure Foundry endpoint host not mapped.
   *   - `invalid-foundry-host-map-target` host map target outside approved subnet.
   *   - `persist-failed`   filesystem write failure (permission/disk).
   *   - `unauthorized-frame` rejected sender frame (shared with gated IPC).
   * The renderer translates each into the Korean user-facing message.
   */
  demo: {
    status: async () =>
      ipcRenderer.invoke("lvis:demo:status") as Promise<
        | { ok: true; activated: boolean; vendor: string | null; autoActivatable: boolean }
        | { ok: false; error: "unauthorized-frame" }
      >,
    activate: async (code: string) =>
      ipcRenderer.invoke("lvis:demo:activate", { code }) as Promise<
        | { ok: true; vendor: string; requiresRelaunch?: boolean }
        | { ok: false; error: "invalid-code" | "no-vendor" | "invalid-vendor" | "no-demo-key" | "missing-foundry-endpoint" | "invalid-foundry-endpoint" | "missing-foundry-host-map" | "foundry-host-map-mismatch" | "invalid-foundry-host-map-target" | "persist-failed" | "unauthorized-frame" }
      >,
    // Embedded activation — same decrypt→validate→persist chain as
    // `activate`, but the code string is the build-time embedded key
    // (`status.autoActivatable === true` advertises it). `no-embedded-code`
    // routes the renderer back to the manual paste input.
    activateEmbedded: async () =>
      ipcRenderer.invoke("lvis:demo:activate-embedded") as Promise<
        | { ok: true; vendor: string; requiresRelaunch?: boolean }
        | { ok: false; error: "no-embedded-code" | "invalid-code" | "no-vendor" | "invalid-vendor" | "no-demo-key" | "missing-foundry-endpoint" | "invalid-foundry-endpoint" | "missing-foundry-host-map" | "foundry-host-map-mismatch" | "invalid-foundry-host-map-target" | "persist-failed" | "unauthorized-frame" }
      >,
    relaunchAfterActivation: async () =>
      ipcRenderer.invoke("lvis:demo:relaunch-after-activation") as Promise<
        | { ok: true }
        | { ok: false; error: "not-armed" | "unauthorized-frame" }
      >,
    // 2026-05-20 — Settings 의 로그아웃 path. .env.demo 파일 + process.env
    // LVIS_DEMO_* + captured demo state 를 한 번에 비워 다음 `status` 호출이
    // `activated=false` 를 반환하도록 한다.
    clearDemo: async () =>
      ipcRenderer.invoke("lvis:demo:clear") as Promise<
        | { ok: true }
        | { ok: false; error: "clear-failed" | "unauthorized-frame" }
      >,
  },
  // Tutorial-C — SpotlightTour state bridge. Host stores tour completion
  // under `~/.lvis/onboarding/tour-state.json`; `tour.start` broadcasts a
  // `lvis:tour:start` event to every open window so detached panes also
  // launch the tour. `getState` is read-never-throws (returns the default
  // shape on any failure) per the project storage contract.
  tour: {
    getState: async () =>
      ipcRenderer.invoke("lvis:tour:get-state") as Promise<
        | {
            ok: true;
            state: {
              lastSeenScenario: string | null;
              completedScenarios: string[];
              dismissedAt: string | null;
            };
          }
        | { ok: false; error: string; message: string }
      >,
    markComplete: async (scenarioId: string) =>
      ipcRenderer.invoke("lvis:tour:mark-complete", { scenarioId }) as Promise<
        | {
            ok: true;
            state: {
              lastSeenScenario: string | null;
              completedScenarios: string[];
              dismissedAt: string | null;
            };
          }
        | { ok: false; error: string; message: string }
      >,
    dismiss: async (scenarioId: string) =>
      ipcRenderer.invoke("lvis:tour:dismiss", { scenarioId }) as Promise<
        | {
            ok: true;
            state: {
              lastSeenScenario: string | null;
              completedScenarios: string[];
              dismissedAt: string | null;
            };
          }
        | { ok: false; error: string; message: string }
      >,
    start: async (scenarioId: string) =>
      ipcRenderer.invoke("lvis:tour:start", { scenarioId }) as Promise<
        | { ok: true; scenarioId: string }
        | { ok: false; error: string; message: string }
      >,
    onStart: (handler: (payload: { scenarioId: string }) => void) => {
      const listener = (
        _event: unknown,
        payload: { scenarioId?: unknown },
      ) => {
        const id = payload?.scenarioId;
        if (typeof id === "string" && id.length > 0) {
          handler({ scenarioId: id });
        }
      };
      ipcRenderer.on("lvis:tour:start", listener);
      return () => ipcRenderer.removeListener("lvis:tour:start", listener);
    },
  },
  // Memory Seed plugin install bridge.
  // Delegates to the canonical `lvis:plugins:install` IPC (same handler
  // the marketplace UI uses); the renderer wraps the response so onboarding
  // dialogs can react to success/failure without depending on the marketplace
  // `PluginMarketplaceActionResult` schema. Errors come back as kebab-case
  // English (CLAUDE.md).
  tutorialInstallPlugin: async (pluginId: string) => {
    const raw = (await ipcRenderer.invoke(
      "lvis:plugins:install",
      pluginId,
    )) as {
      ok?: boolean;
      pluginId?: string;
      error?: string;
      message?: string;
    } | null;
    if (raw && raw.ok === true && typeof raw.pluginId === "string") {
      return { ok: true as const, pluginId: raw.pluginId };
    }
    return {
      ok: false as const,
      error: typeof raw?.error === "string" ? raw.error : "install-failed",
      message: typeof raw?.message === "string" ? raw.message : "plugin install failed",
    };
  },
  // Tutorial-X4 — Onboarding Context writer. Called once by the renderer
  // after the Memory Seed wizard dismisses with a short markdown block
  // (호칭 + 자기소개 + installed plugin slugs). The host writes the file
  // under `~/.lvis/onboarding/onboarding-context.md`; the SystemPromptBuilder
  // then injects it as section id=9.86 "User Onboarding Context" on each
  // subsequent turn until the user clears it.
  onboardingContextSet: async (content: string) =>
    ipcRenderer.invoke("lvis:onboarding:context:set", { content }) as Promise<
      | { ok: true }
      | { ok: false; error: string; message: string }
    >,
  openSettingsWindow: async (initialTab?: string) =>
    ipcRenderer.invoke("lvis:settings-window:open", initialTab) as Promise<
      { ok: true; windowId: number } | { ok: false; error: string }
    >,
  notifySettingsWindowSaved: async () =>
    ipcRenderer.invoke("lvis:settings-window:saved") as Promise<{ ok: true } | { ok: false; error: string }>,
  onSettingsWindowSaved: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("lvis:settings-window:saved", listener);
    return () => ipcRenderer.removeListener("lvis:settings-window:saved", listener);
  },
  onSettingsWindowTab: (handler: (initialTab: string) => void) => {
    const listener = (_event: unknown, payload: { initialTab?: unknown }) => {
      if (typeof payload?.initialTab === "string") handler(payload.initialTab);
    };
    ipcRenderer.on("lvis:settings-window:tab", listener);
    return () => ipcRenderer.removeListener("lvis:settings-window:tab", listener);
  },
  // Open an http(s) URL in the system browser. Main-side validates the
  // scheme and rejects file://, javascript:, and any other handler.
  openExternalUrl: async (url: string) =>
    ipcRenderer.invoke("lvis:shell:open-external", url) as Promise<{
      ok: boolean;
      error?: string;
      protocol?: string;
      message?: string;
    }>,
  // #FU259 — MCP marketplace catalog + install
  listMcpCatalog: async () => ipcRenderer.invoke("lvis:mcp:catalog:list"),
  installMcpFromMarketplace: async (slug: string) =>
    ipcRenderer.invoke("lvis:mcp:install-from-marketplace", slug),
  // #FU262 — Claude Desktop config import (two-phase: preview → apply).
  previewClaudeDesktopMcpImport: async (raw: string) =>
    ipcRenderer.invoke("lvis:mcp:import:claude-desktop:preview", raw),
  applyClaudeDesktopMcpImport: async (payload: { raw: string; conflictPolicy?: "skip" | "overwrite" }) =>
    ipcRenderer.invoke("lvis:mcp:import:claude-desktop:apply", payload),

  notifyPluginTheme: (payload: {
    bundleId: string;
    shell: "light" | "dark";
    tokens: Record<string, string>;
  }) =>
    ipcRenderer.invoke("lvis:host:plugin-theme-notify", payload),

  // Plugin-owned OAuth removed host-owned provider auth IPC bridges.
  // 플러그인이 자체 인증을 소유한다.

  // ─── Chat (ConversationLoop) ─────────────────────
  chatHasProvider: async () => ipcRenderer.invoke("lvis:chat:has-provider") as Promise<boolean>,
  captureUserKeyboardIntent,
  chatSend: async (
    input: string,
    attachments: unknown[] | undefined,
    inputOrigin: ChatSendInputOrigin,
    userIntent?: UserKeyboardIntentSnapshot,
    personaPromptId?: string,
  ) =>
    ipcRenderer.invoke("lvis:chat:send", {
      input,
      attachments,
      inputOrigin,
      ...(personaPromptId ? { personaPromptId } : {}),
      ...(inputOrigin === "user-keyboard"
        ? { userActivation: consumeUserKeyboardIntent(userIntent) }
        : {}),
    }),
  chatGuide: async (input: string) => ipcRenderer.invoke("lvis:chat:guide", input),
  chatNew: async () => ipcRenderer.invoke("lvis:chat:new"),
  chatSessions: async (opts?: { kind?: "main" | "routine" | "all"; routineId?: string; limit?: number; before?: string; beforeId?: string; after?: string }) =>
    ipcRenderer.invoke("lvis:chat:sessions", opts) as Promise<{
      current: string;
      sessions: Array<{
        id: string;
        modifiedAt: string;
        title: string;
        sessionKind: "main" | "routine";
        routineId?: string;
        routineTitle?: string;
        routineFiredAt?: string;
        branchedFromCompactNum?: number;
        branchedAt?: string;
      }>;
    }>,
  // Conversation UX
  chatGetHistory: async () =>
    ipcRenderer.invoke("lvis:chat:get-history") as Promise<{
      sessionId: string;
      sessionTitle?: string;
      sessionKind: "main" | "routine";
      routineId?: string;
      routineTitle?: string;
      messages: SerializedHistoryMessage[];
    }>,
  chatMainActiveState: async () =>
    ipcRenderer.invoke("lvis:chat:main-active-state") as Promise<{
      mainActiveSessionId: string | null;
      mainActiveMode: "resume" | "fresh";
      updatedAt: string;
    } | null>,
  chatSessionHistory: async (sessionId: string) =>
    ipcRenderer.invoke("lvis:chat:session-history", sessionId) as Promise<{
      ok: boolean;
      sessionTitle?: string;
      sessionKind?: "main" | "routine";
      routineId?: string;
      routineTitle?: string;
      routineFiredAt?: string;
      messages: SerializedHistoryMessage[];
      /** Chars in the rolling summary preamble applied to this session. 0 = no preamble. */
      preambleChars?: number;
    }>,
  chatEditResend: async (messageIndex: number, newText: string) =>
    ipcRenderer.invoke("lvis:chat:edit-resend", messageIndex, newText),
  chatFork: async (messageIndex: number) => ipcRenderer.invoke("lvis:chat:fork", messageIndex),
  chatContinueLastUser: async (sessionId: string) =>
    ipcRenderer.invoke("lvis:chat:continue-last-user", { sessionId }) as Promise<{ ok: boolean; error?: string }>,
  chatRetryEffort: async (opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean }) =>
    ipcRenderer.invoke("lvis:chat:retry-effort", opts),
  chatExport: async (format: "markdown" | "json") => ipcRenderer.invoke("lvis:chat:export", format),
  chatCompact: async () => ipcRenderer.invoke("lvis:chat:compact"),
  chatSessionResume: async (sessionId: string) => ipcRenderer.invoke("lvis:chat:session-resume", sessionId),
  // Checkpoint view and explicit branch actions.
  chatEnterCheckpointView: async (sessionId: string, compactNum: number) =>
    ipcRenderer.invoke("lvis:chat:enter-checkpoint-view", { sessionId, compactNum }) as Promise<
      { messageIndexAtCreation: number } | { error: string }
    >,
  chatExitCheckpointView: async () =>
    ipcRenderer.invoke("lvis:chat:exit-checkpoint-view") as Promise<{ ok: boolean }>,
  chatBranchFromCheckpoint: async (sessionId: string, compactNum: number) =>
    ipcRenderer.invoke("lvis:chat:branch-from-checkpoint", { sessionId, compactNum }) as Promise<
      {
        newSessionId: string;
        lastMessageRole: "user" | "assistant" | "tool_result" | null;
        shouldAutoContinue: boolean;
      } | { error: string }
    >,
  chatAbort: async () => ipcRenderer.invoke("lvis:chat:abort") as Promise<{ ok: boolean }>,
  // Lazy-load verbatim tool_result content (in-session only).
  chatGetVerbatimToolResult: async (sessionId: string, toolUseId: string) =>
    ipcRenderer.invoke("lvis:chat:get-verbatim-tool-result", { sessionId, toolUseId }) as Promise<
      { content: string; lineCount: number } | null
    >,
  // Issue #749: lazy-load full write_file diff when content exceeds preview limit
  chatGetWriteDiff: async (sessionId: string, toolUseId: string) =>
    ipcRenderer.invoke("lvis:chat:get-write-diff", { sessionId, toolUseId }) as Promise<
      { before: string; after: string } | null
    >,
  starredList: async () => ipcRenderer.invoke("lvis:starred:list"),
  starredAdd: async (entry: { sessionId?: string; messageIndex: number; role: string; text: string }) =>
    ipcRenderer.invoke("lvis:starred:add", entry),
  starredRemove: async (opts: { id?: string; sessionId?: string; messageIndex?: number }) =>
    ipcRenderer.invoke("lvis:starred:remove", opts),
  onChatStream: (handler: (event: StreamEvent) => void) => {
    const listener = (_event: unknown, payload: StreamEvent) => handler(payload);
    ipcRenderer.on("lvis:chat:stream", listener);
    return () => ipcRenderer.removeListener("lvis:chat:stream", listener);
  },
  onChatFallback: (handler: (payload: { from: string; to: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:chat:fallback", listener);
    return () => ipcRenderer.removeListener("lvis:chat:fallback", listener);
  },

  // ─── Memory ──────────────────────────────────────
  memoryListEntries: async () => ipcRenderer.invoke("lvis:memory:entries:list"),
  memorySaveEntry: async (title: string, content: string) => ipcRenderer.invoke("lvis:memory:entries:save", title, content),
  memoryDeleteEntry: async (filename: string) => ipcRenderer.invoke("lvis:memory:entries:delete", filename),
  memorySearchEntries: async (query: string) => ipcRenderer.invoke("lvis:memory:entries:search", query),
  memoryGetIndex: async () => ipcRenderer.invoke("lvis:memory:index:get") as Promise<string>,
  memoryUpdateIndexIfUnchanged: async (expectedContent: string, nextContent: string) =>
    ipcRenderer.invoke("lvis:memory:index:update-if-unchanged", expectedContent, nextContent) as Promise<boolean>,
  memoryUpdateIndexSections: async (sections: { urgentMemory?: string; references?: string }) =>
    ipcRenderer.invoke("lvis:memory:index:sections:update", sections),
  memoryListSessions: async () => ipcRenderer.invoke("lvis:memory:sessions:list"),
  memorySearchSessions: async (query: string) => ipcRenderer.invoke("lvis:memory:sessions:search", query),
  memoryGetAgentsMd: async () => ipcRenderer.invoke("lvis:memory:agents-md:get") as Promise<string>,
  memoryUpdateAgentsMd: async (content: string) => ipcRenderer.invoke("lvis:memory:agents-md:update", content),
  memoryGetUserPrefs: async () => ipcRenderer.invoke("lvis:memory:user-prefs:get") as Promise<string>,
  memoryUpdateUserPrefs: async (content: string) => ipcRenderer.invoke("lvis:memory:user-prefs:update", content),
  memoryRefreshUserPrefs: async () => ipcRenderer.invoke("lvis:memory:user-prefs:refresh"),

  // ─── Plugins ─────────────────────────────────────
  listMarketplacePlugins: async () => ipcRenderer.invoke("lvis:plugins:marketplace:list"),
  listPersonaPromptSummaries: async () => ipcRenderer.invoke("lvis:prompts:list-summaries"),
  listPersonaPrompts: async () => ipcRenderer.invoke("lvis:prompts:list"),
  savePersonaPrompt: async (prompt: { id: string; name: string; systemPromptAdd: string }) =>
    ipcRenderer.invoke("lvis:prompts:save", prompt),
  deletePersonaPrompt: async (id: string) => ipcRenderer.invoke("lvis:prompts:delete", id),
  listAgentProfiles: async () => ipcRenderer.invoke("lvis:agents:list"),
  listSkills: async () => ipcRenderer.invoke("lvis:skills:list"),
  installAgentFromMarketplace: async (slug: string) =>
    ipcRenderer.invoke("lvis:agents:install", slug),
  uninstallAgentPackage: async (slug: string) =>
    ipcRenderer.invoke("lvis:agents:uninstall", slug),
  installSkillFromMarketplace: async (slug: string) =>
    ipcRenderer.invoke("lvis:skills:install", slug),
  uninstallSkillPackage: async (slug: string) =>
    ipcRenderer.invoke("lvis:skills:uninstall", slug),
  listPluginUiExtensions: async () => ipcRenderer.invoke("lvis:plugins:ui:list"),
  // #237 — host renderer pre-binds (webContents.id → pluginId, entryUrl)
  // before each plugin webview navigates. Main rejects unknown pluginId
  // and any non-host frame.
  registerPluginWebview: async (payload: { webContentsId: number; pluginId: string; entryUrl: string }) =>
    ipcRenderer.invoke("lvis:plugin:register-webview", payload) as Promise<{ ok: boolean; error?: string }>,
  readPluginUiModule: async (pluginId: string, viewId: string) =>
    ipcRenderer.invoke("lvis:plugins:ui:read-module", { pluginId, viewId }) as Promise<string>,
  listPluginCards: async () => ipcRenderer.invoke("lvis:plugins:cards"),
  // #1176 — toggle a plugin active/inactive. Returns the IPC result frame
  // ({ ok, pluginId, enabled } | { ok:false, error, message }).
  setPluginEnabled: async (pluginId: string, enabled: boolean) =>
    ipcRenderer.invoke("lvis:plugins:set-enabled", pluginId, enabled),
  callPluginMethod: async (method: string, payload?: unknown) => ipcRenderer.invoke("lvis:plugins:call", method, payload),

  // ─── Plugin Performance (Observability) ──────────
  plugins: {
    getPerfStats: async () => ipcRenderer.invoke("lvis:plugins:perf-stats"),
  },

  // ─── Usage Observability ─────────────────────────
  getUsageSummary: async (days?: number) => ipcRenderer.invoke("lvis:usage:summary", days),
  getUsageRange: async (opts: { dateFrom: string; dateTo: string }) => ipcRenderer.invoke("lvis:usage:range", opts),
  exportUsageCsv: async (rows: Array<Record<string, string | number>>) => ipcRenderer.invoke("lvis:usage:export-csv", rows),

  // ─── Overlay trigger lifecycle ────────────────────────────────────────
  onTriggerStarted: (
    handler: (payload: {
      sessionId: string;
      pluginId: string;
      source: string;
      visibility: "silent" | "summary-only" | "user-visible";
      priority: "low" | "normal" | "high";
      startedAt: string;
    }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:trigger:started", listener);
    return () => ipcRenderer.removeListener("lvis:trigger:started", listener);
  },
  onTriggerCompleted: (
    handler: (result: {
      sessionId: string;
      pluginId: string;
      source: string;
      visibility: "silent" | "summary-only" | "user-visible";
      priority: "low" | "normal" | "high";
      prompt: string;
      summary: string;
      completedAt: string;
    }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:trigger:completed", listener);
    return () => ipcRenderer.removeListener("lvis:trigger:completed", listener);
  },
  onTriggerFailed: (
    handler: (payload: {
      sessionId: string;
      pluginId: string;
      source: string;
      reason: "provider_error" | "tool_error" | "abort" | "unknown";
      errorId: string;
    }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:trigger:failed", listener);
    return () => ipcRenderer.removeListener("lvis:trigger:failed", listener);
  },
  onTriggerExpired: (
    handler: (payload: { sessionId: string; pluginId: string; source: string }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:trigger:expired", listener);
    return () => ipcRenderer.removeListener("lvis:trigger:expired", listener);
  },
  onTriggerImported: (
    handler: (payload: {
      sessionId: string;
      source: string;
      prompt: string;
      summary: string;
      toolCallCount: number;
      importedAt: string;
      wrappedPrompt: string;
    }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:trigger:imported", listener);
    return () => ipcRenderer.removeListener("lvis:trigger:imported", listener);
  },
  dismissTrigger: async (sessionId: string) =>
    ipcRenderer.invoke("lvis:trigger:dismiss", sessionId) as Promise<{
      ok: boolean;
      removed?: boolean;
      error?: string;
    }>,
  importTrigger: async (sessionId: string) =>
    ipcRenderer.invoke("lvis:trigger:import", sessionId) as Promise<{
      ok: boolean;
      imported?: number;
      reason?: string;
      error?: string;
    }>,

  // ─── Marketplace update notifications (S8) ───────
  onMarketplaceUpdatesAvailable: (handler: (updates: Array<{ pluginId: string; pluginName?: string; installedVersion: string; latestVersion: string }>) => void) => {
    const listener = (_event: unknown, updates: Parameters<typeof handler>[0]) => handler(updates);
    ipcRenderer.on("marketplace:updates-available", listener);
    return () => ipcRenderer.removeListener("marketplace:updates-available", listener);
  },

  // ─── Marketplace announcements ───────────────────
  // The host pushes the active, not-yet-dismissed announcement set whenever
  // the announcement poller runs (boot + interval). Dismissals are persisted
  // by the renderer via updateSettings, and the host filters them out before
  // the next push so a dismissed banner never reappears.
  onMarketplaceAnnouncements: (handler: (announcements: MarketplaceAnnouncementPayload) => void) => {
    const listener = (_event: unknown, announcements: Parameters<typeof handler>[0]) => handler(announcements);
    ipcRenderer.on(MARKETPLACE.announcements, listener);
    return () => ipcRenderer.removeListener(MARKETPLACE.announcements, listener);
  },

  // ─── App auto-update (electron-updater) ──────────
  // Main process emits `lvis:update:state` whenever the updater state
  // transitions (available / downloading / downloaded). Renderer renders
  // a permanent badge next to the Home button so the user always sees the
  // current state, not a transient toast. The two action commands are
  // user-gated — `downloadAppUpdate` is only called from a badge click,
  // never automatically (사용자 명시 클릭 전엔 절대 다운로드 금지).
  // UpdateState type imported from the SoT at src/shared/update-state.ts
  // so adding a new variant only needs editing that one file.
  onAppUpdateState: (
    handler: (state: import("./shared/update-state.js").UpdateState) => void,
  ) => {
    const listener = (_event: unknown, state: Parameters<typeof handler>[0]) => handler(state);
    ipcRenderer.on("lvis:update:state", listener);
    return () => ipcRenderer.removeListener("lvis:update:state", listener);
  },
  /** Fetch the last-known state synchronously (for late-mounting components
   *  that miss the initial broadcast). Returns { kind: "idle" } before the
   *  first check completes. */
  getAppUpdateState: () =>
    ipcRenderer.invoke("lvis:update:get-state") as Promise<
      import("./shared/update-state.js").UpdateState
    >,
  /** Start the actual download. Only valid when the current state is
   *  "available"; rejected (ok:false) otherwise. */
  downloadAppUpdate: () =>
    ipcRenderer.invoke("lvis:update:download-now") as Promise<{ ok: boolean; reason?: string }>,
  /** Quit and apply the downloaded update. Main validates the sender and
   *  owns the native confirmation dialog before it calls quitAndInstall().
   *  Only valid when the current state is "downloaded"; rejected
   *  (ok:false) otherwise. */
  installAppUpdate: () =>
    ipcRenderer.invoke("lvis:update:install-now") as Promise<{ ok: boolean; reason?: string }>,

  // ─── Managed bootstrap status ────────────────────
  // The host emits these around `ensureManagedInstalled()` so the renderer
  // can show a banner / toast during startup install. Three lifecycle states:
  //   - { phase: "start" }
  //   - { phase: "complete", installed[], failed[], skippedReason? }
  //   - { phase: "error", message }
  // Best-effort: the host swallows send errors, so the renderer must
  // tolerate missing events (page reload during startup, etc.).
  onBootstrapStatus: (
    handler: (status:
      | { phase: "start" }
      | { phase: "complete"; installed: string[]; failed: Array<{ id: string; error: string }>; skippedReason?: string }
      | { phase: "error"; message: string }
    ) => void,
  ) => {
    const listener = (_event: unknown, status: Parameters<typeof handler>[0]) => handler(status);
    ipcRenderer.on("lvis:bootstrap:status", listener);
    return () => ipcRenderer.removeListener("lvis:bootstrap:status", listener);
  },
  // Banner-driven retry. Re-emits the start/complete/error
  // status sequence so the banner subscriber updates without needing a
  // separate result channel.
  retryBootstrap: () => ipcRenderer.invoke("lvis:bootstrap:retry"),

  // ─── lvis:// deep-link install lifecycle ─────────
  // Fires when a marketplace install triggered via lvis://install/{slug} has
  // finished installing + restartAll() in the main process. Renderer uses
  // this to refresh its plugin UI list so newly-installed plugin views
  // appear without requiring an app restart.
  onPluginInstallResult: (handler: (payload: { slug: string; success: boolean; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:plugins:install-result", listener);
    return () => ipcRenderer.removeListener("lvis:plugins:install-result", listener);
  },

  /**
   * Dev-only: install a plugin from a local directory (LVIS_DEV=1 required).
   *
   * Return shape:
   *   - `null` — the user cancelled the folder picker. NOT an error.
   *   - `{ pluginId, installed: true }` — install succeeded.
   *   - throws — auth/dev-mode/IO error. Callers should surface this as a
   *     toast/alert rather than collapsing it into `null`, otherwise users
   *     can't distinguish "didn't run" from "ran but failed". See
   *     `installLocal` in `src/plugins/marketplace.ts` for the error
   *     producer side.
   */
  installLocalPlugin: async () => {
    const r = await ipcRenderer.invoke("lvis:plugins:install-local") as
      | { pluginId: string; installed: true }
      | { ok: false; error: string }
      | null;
    if (!r) return null; // user cancelled the folder picker
    if ("ok" in r) {
      throw new Error(`installLocalPlugin: ${r.error}`);
    }
    return r;
  },

  // Sibling of onPluginInstallResult — fires after PluginConfigTab or any
  // other surface drives uninstall through the IPC handler. Renderer uses
  // this to drop the removed plugin view + marketplace card.
  onPluginUninstallResult: (handler: (payload: { slug: string; success: boolean; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:plugins:uninstall-result", listener);
    return () => ipcRenderer.removeListener("lvis:plugins:uninstall-result", listener);
  },
  // #1176 — fires after a plugin's active/inactive state is toggled (via this
  // surface or any other). Renderer surfaces use this to refresh plugin cards
  // so a disabled plugin's tools/UI disappear (and reappear on re-enable).
  onPluginEnabledChanged: (handler: (payload: { pluginId: string; enabled: boolean }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:plugins:enabled-changed", listener);
    return () => ipcRenderer.removeListener("lvis:plugins:enabled-changed", listener);
  },
  onPluginRuntimeUpdated: (handler: (payload: { pluginId: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:plugins:runtime-updated", listener);
    return () => ipcRenderer.removeListener("lvis:plugins:runtime-updated", listener);
  },
  onPersonaPromptsUpdated: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("lvis:prompts:updated", listener);
    return () => ipcRenderer.removeListener("lvis:prompts:updated", listener);
  },

  onAgentInstallResult: (handler: (payload: { slug: string; success: boolean; agentId?: string; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:agents:install-result", listener);
    return () => ipcRenderer.removeListener("lvis:agents:install-result", listener);
  },
  onAgentUninstallResult: (handler: (payload: { slug: string; success: boolean; agentId?: string; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:agents:uninstall-result", listener);
    return () => ipcRenderer.removeListener("lvis:agents:uninstall-result", listener);
  },
  onSkillInstallResult: (handler: (payload: { slug: string; success: boolean; skillId?: string; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:skills:install-result", listener);
    return () => ipcRenderer.removeListener("lvis:skills:install-result", listener);
  },
  onSkillUninstallResult: (handler: (payload: { slug: string; success: boolean; skillId?: string; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:skills:uninstall-result", listener);
    return () => ipcRenderer.removeListener("lvis:skills:uninstall-result", listener);
  },

  // Phase progress for in-flight installs. Granular phases fire from inside
  // installFromMarketplace: downloading (byte-level) → verifying → registering.
  // The callers (handleLvisUri, lvis:plugins:install) emit `installing` at the
  // start and `restarting` after the install completes. The result event clears
  // the in-flight state. Renderer renders a skeleton card.
  onPluginInstallProgress: (handler: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" | "preparing" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:plugins:install-progress", listener);
    return () => ipcRenderer.removeListener("lvis:plugins:install-progress", listener);
  },
  onAgentInstallProgress: (handler: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:agents:install-progress", listener);
    return () => ipcRenderer.removeListener("lvis:agents:install-progress", listener);
  },
  onSkillInstallProgress: (handler: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:skills:install-progress", listener);
    return () => ipcRenderer.removeListener("lvis:skills:install-progress", listener);
  },

  // Status bar — aggregated runtime counters (tools / plugins / mcps).
  getRuntimeCounts: async () =>
    ipcRenderer.invoke("lvis:runtime:counts") as Promise<{
      tools: number;
      plugins: number;
      mcps: number;
    }>,
  // Status bar — static environment info (platform / hostname / user).
  // Static enough to fetch once on mount; values don't change while the
  // process is alive. Cwd is intentionally NOT exposed — least-privilege
  // for plugin UI panels that share this contextBridge.
  getRuntimeEnv: async () =>
    ipcRenderer.invoke("lvis:runtime:env") as Promise<{
      platform: string;
      hostname: string;
      user: string;
    }>,
  // Status bar — marketplace reachability probe. Returns `configured: false`
  // when the user is on the mock backend (nothing to ping).
  pingMarketplace: async () =>
    ipcRenderer.invoke("lvis:marketplace:ping") as Promise<{
      configured: boolean;
      online: boolean;
    }>,
  // Status bar — active LLM provider reachability probe. This performs a
  // tiny one-shot model call from the main process so "connected" means the
  // provider itself answered, not only that the marketplace backend is online.
  pingAiProvider: async () =>
    ipcRenderer.invoke("lvis:llm:ping") as Promise<AiProviderPingIpcResult>,

  // Settings "일반" dashboard — host metadata. SoT for `version` is the
  // LVIS project package.json (resolved by the main process via
  // `app.getAppPath()`); stack fields come from `process.versions`. The
  // renderer never hard-codes these values.
  getAppInfo: async () =>
    ipcRenderer.invoke("lvis:app:info") as Promise<{
      version: string;
      electronVersion: string;
      nodeVersion: string;
      chromeVersion: string;
      v8Version: string;
      platform: NodeJS.Platform;
      arch: string;
      userDataPath: string;
    }>,

  // ─── Plugin Events ──────────────────────────────
  onPluginEvent: (
    eventType: string,
    handler: (data: unknown) => void,
  ): (() => void) => {
    // Reject subscriptions to private-namespace events at the preload boundary.
    // PLUGIN_PRIVATE_NAMESPACES entries are dot-separated prefixes; an event
    // type matches when it equals a namespace or starts with "<namespace>.".
    // This prevents renderer code from subscribing to sensitive host state
    // (memory contents, secrets, audit trails, DLP decisions) even if the IPC
    // channel delivers them. Mirrors capability enforcement in
    // plugins/capabilities.ts.
    const isPrivate = [...PLUGIN_PRIVATE_NAMESPACES].some(
      (ns) => eventType === ns || eventType.startsWith(`${ns}.`),
    );
    if (isPrivate) {
      // Return a no-op unsubscribe — the subscription is silently rejected.
      return () => undefined;
    }
    const listener = (_event: unknown, type: string, data: unknown) => {
      if (type === eventType) handler(data);
    };
    ipcRenderer.on("lvis:plugin:event", listener);
    return () => ipcRenderer.removeListener("lvis:plugin:event", listener);
  },

  // ─── MCP ─────────────────────────────────────────
  mcp: {
    servers: async () => ipcRenderer.invoke("lvis:mcp:servers"),
    kill: async (id: string) => ipcRenderer.invoke("lvis:mcp:kill", id),
    getConfigs: async () => ipcRenderer.invoke("lvis:mcp:config:get"),
    getConfigPath: async () => ipcRenderer.invoke("lvis:mcp:config:path"),
    addConfig: async (config: McpServerConfig) => ipcRenderer.invoke("lvis:mcp:config:add", config),
    setApiKey: async (id: string, apiKey: string) => ipcRenderer.invoke("lvis:mcp:config:set-api-key", id, apiKey),
    removeConfig: async (id: string) => ipcRenderer.invoke("lvis:mcp:config:remove", id),
    readUiResource: async (serverId: string, uri: string) => ipcRenderer.invoke("lvis:mcp:ui-resource", serverId, uri) as Promise<string>,
  },

  // ─── Permission ───────────────────────────────────
  permission: {
    getMode: async () => ipcRenderer.invoke(PERMISSIONS.getMode),
    setMode: async (mode: string) => ipcRenderer.invoke(PERMISSIONS.setMode, {
      mode,
      intent: ipcUserKeyboardIntent(),
    }),
    onModeChanged: (cb: (mode: string) => void) => {
      const listener = (_event: unknown, payload: { mode?: unknown }) => {
        if (typeof payload?.mode === "string") cb(payload.mode);
      };
      ipcRenderer.on(PERMISSIONS.modeChanged, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.modeChanged, listener);
    },
    /**
     * Hint event — directory config mutated. Listeners refresh state by
     * calling `permission.dirDispatch("list")` rather than receiving the
     * full directory list in the broadcast payload (slash dispatcher is
     * the single source of truth).
     */
    onConfigChanged: (cb: () => void) => {
      const listener = () => cb();
      ipcRenderer.on(PERMISSIONS.configChanged, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.configChanged, listener);
    },
    listRules: async () => ipcRenderer.invoke(PERMISSIONS.listRules),
    addRule: async (pattern: string, action: string) =>
      ipcRenderer.invoke(PERMISSIONS.addRule, { pattern, action, intent: ipcUserKeyboardIntent() }),
    removeRule: async (pattern: string, action: string) =>
      ipcRenderer.invoke(PERMISSIONS.removeRule, { pattern, action, intent: ipcUserKeyboardIntent() }),
    /** Permission policy — deferred queue for reviewer HIGH verdicts. */
    deferredList: async () => ipcRenderer.invoke(PERMISSIONS.deferredList),
    /** Permission policy issue #633 — hook quarantine state for non-modal settings badge. */
    hookTrustList: async () => ipcRenderer.invoke(PERMISSIONS.hookTrustList),
    /** Permission policy — `/permission dir ...` slash dispatch via IPC. */
    dirDispatch: async (rawArgs: string) =>
      ipcRenderer.invoke(PERMISSIONS.dirDispatch, { rawArgs, intent: ipcUserKeyboardIntent() }),
    deferredResolve: async (
      id: string,
      decision: "approved" | "rejected",
      reason: string | undefined,
      // Required: callers must explicitly opt into a provenance value
      // before main writes the HMAC-chained audit row.
      approvalSource: "button" | "natural-language",
    ) =>
      ipcRenderer.invoke(PERMISSIONS.deferredResolve, {
        id,
        decision,
        reason,
        approvalSource,
        intent: ipcUserKeyboardIntent(),
      }),
    /** Foreground-entry pending notification — main→renderer event. */
    onDeferredPending: (cb: (summary: { pending: number }) => void) => {
      const listener = (_event: unknown, summary: { pending: number }) =>
        cb(summary);
      ipcRenderer.on(PERMISSIONS.deferredPending, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.deferredPending, listener);
    },
    /** CRITICAL 4.1: memory-hit auto-approve disclosure — main→renderer event. */
    onUserApprovalHit: (cb: (payload: UserApprovalHitPayload) => void) => {
      const listener = (_event: unknown, payload: UserApprovalHitPayload) =>
        cb(payload);
      ipcRenderer.on(PERMISSIONS.userApprovalHit, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.userApprovalHit, listener);
    },
    /** Permission policy — `/permission reviewer ...` slash dispatch via IPC. */
    reviewerDispatch: async (rawArgs: string) =>
      ipcRenderer.invoke(PERMISSIONS.reviewerDispatch, { rawArgs, intent: ipcUserKeyboardIntent() }),
    /** C3 — check whether a reviewer provider has its required API key stored. */
    reviewerProviderHasKey: async (provider: string) =>
      ipcRenderer.invoke(PERMISSIONS.reviewerProviderHasKey, provider),
    /** Permission policy — `/permission audit show` — fetch recent permission audit entries. */
    auditShow: async (last: number) =>
      ipcRenderer.invoke(PERMISSIONS.auditShow, { last }),
    /** Permission policy — `/permission audit verify` — chain integrity check. */
    auditVerify: async () =>
      ipcRenderer.invoke(PERMISSIONS.auditVerify),
    /**
     * Permission policy — manifest integrity violation notifier. Subscribes
     * to `PERMISSIONS.manifestViolation` so the renderer can
     * surface a "Plugin X disabled — reinstall?" prompt.
     */
    onManifestViolation: (
      handler: (payload: {
        pluginId: string;
        toolName: string;
        attempted: string;
      }) => void,
    ) => {
      const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) =>
        handler(payload);
      ipcRenderer.on(PERMISSIONS.manifestViolation, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.manifestViolation, listener);
    },
  },

  // ─── Policy (Governance) ─────────────────────────
  policy: {
    get: async () => ipcRenderer.invoke(PERMISSIONS.policyGet),
    set: async (patch: unknown) =>
      ipcRenderer.invoke(PERMISSIONS.policySet, { patch, intent: ipcUserKeyboardIntent() }),
  },

  // ─── Approval Gate ─────────────────────────────
  approval: {
    /** main→renderer 단방향 이벤트 구독 */
    onRequest: (cb: (req: unknown) => void) => {
      const listener = (_event: unknown, req: unknown) => cb(req);
      ipcRenderer.on("lvis:approval:request", listener);
      return () => ipcRenderer.removeListener("lvis:approval:request", listener);
    },
    /** 사용자 결정을 main으로 전송 */
    respond: async (decision: unknown) =>
      ipcRenderer.invoke(PERMISSIONS.approvalRespond, decision),
  },

  // ─── User-Approval Store ─────────────
  userApproval: {
    /** Record a user approval decision (scope: session | persistent). */
    record: async (entry: {
      /** Server-side ApprovalRequest binding — required for IPC handler validation. */
      requestId: string;
      toolName: string;
      args: string;
      source: string;
      scope: UserApprovalScope;
      verdictAtApproval: UserApprovalVerdict;
      nlJustification: string | null;
      /** Propagated for record/lookup key symmetry. */
      trustOrigin?: string;
      /** Propagated for record/lookup key symmetry. */
      approvalCacheKey?: string;
    }) => ipcRenderer.invoke(PERMISSIONS.userApprovalRecord, { ...entry, intent: ipcUserKeyboardIntent() }),
    /** Revoke an approval by raw composite key. */
    revokeByKey: async (key: string) =>
      ipcRenderer.invoke(PERMISSIONS.userApprovalRevoke, { key, intent: ipcUserKeyboardIntent() }),
    /** List all approval entries (for PermissionsTab display). */
    list: async () => ipcRenderer.invoke(PERMISSIONS.userApprovalList),
  },

  // ─── DLP Hit Statistics (Observability) ─────────
  dlp: {
    getStats: async (days: number) => ipcRenderer.invoke("lvis:dlp:stats", days),
  },

  // ─── Audit Log Search (Observability) ────────────
  audit: {
    search: async (filter: {
      dateFrom?: string;
      dateTo?: string;
      type?: string;
      textSearch?: string;
      limit?: number;
      offset?: number;
    }) => ipcRenderer.invoke("lvis:audit:search", filter),
    getStats: async (lastDays: number) => ipcRenderer.invoke("lvis:audit:stats", lastDays),
  },

  // ─── Message feedback ────────────────────────────
  submitFeedback: async (payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) =>
    ipcRenderer.invoke("lvis:feedback:submit", payload) as Promise<{ ok: boolean; error?: string }>,

  // ─── View Events ─────────────────────────────────
  onViewActivate: (handler: (viewKey: string) => void) => {
    const listener = (_event: unknown, payload: { viewKey?: string }) => handler(payload?.viewKey ?? "home");
    ipcRenderer.on("lvis:view:activate", listener);
    return () => ipcRenderer.removeListener("lvis:view:activate", listener);
  },

  // ─── Workflow tools (S1+S2) ──────────────────────
  // ask_user_question — main process pushes inline question requests; the
  // renderer card resolves via the respond channel.
  onAskUserQuestion: (
    handler: (req: {
      id: string;
      questions: Array<{
        question: string;
        choices?: string[];
        recommendedIndex?: number;
        altIndices?: number[];
        allowFreeText: boolean;
        allowMultiple?: boolean;
        placeholder?: string;
        summaryHint?: string;
        suggestedAnswers?: string[];
      }>;
      createdAt: number;
    }) => void,
  ) => {
    const listener = (_e: unknown, req: Parameters<typeof handler>[0]) => handler(req);
    ipcRenderer.on("lvis:ask-user-question:request", listener);
    return () => ipcRenderer.removeListener("lvis:ask-user-question:request", listener);
  },
  respondAskUserQuestion: async (response: {
    requestId: string;
    answers?: Array<{ choice?: string; choices?: string[]; freeText?: string }>;
    dismissed?: boolean;
  }) => ipcRenderer.invoke("lvis:ask-user-question:respond", response),
  // Timeout side-channel — main process notifies the renderer when an
  // ask_user_question request expired (5 min default) so the card can drop
  // the stale prompt before the user clicks into a no-op.
  onAskUserQuestionTimeout: (
    handler: (payload: { requestId: string }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on("lvis:ask-user-question:timeout", listener);
    return () => ipcRenderer.removeListener("lvis:ask-user-question:timeout", listener);
  },

  // routine_schedule v2 — persistent routine list + lifecycle
  listRoutinesV2: async () => ipcRenderer.invoke(ROUTINES_V2.list),
  dismissRoutineV2: async (id: string) => ipcRenderer.invoke(ROUTINES_V2.dismiss, id),
  removeRoutineV2: async (id: string) => ipcRenderer.invoke(ROUTINES_V2.remove, id),
  triggerRoutineNowV2: async (id: string) => ipcRenderer.invoke(ROUTINES_V2.triggerNow, id),
  listPendingRoutineResultsV2: async () =>
    ipcRenderer.invoke(ROUTINES_V2.pendingResults) as Promise<
      import("./shared/routines-types.js").RoutineFiredPayload[]
    >,
  acknowledgeRoutineResultV2: async (routineId: string, firedAt: string) =>
    ipcRenderer.invoke(ROUTINES_V2.acknowledgeResult, routineId, firedAt) as Promise<{ ok: boolean; error?: string }>,
  addRoutineV2: async (input: import("./shared/routines-types.js").AddRoutineInput) =>
    ipcRenderer.invoke(ROUTINES_V2.add, input) as Promise<
      { ok: true; routine: import("./shared/routines-types.js").RoutineRecord } | { ok: false; error: string }
    >,
  onRoutineFiredV2: (
    handler: (event: import("./shared/routines-types.js").RoutineFiredPayload) => void,
  ) => {
    const listener = (_e: unknown, r: Parameters<typeof handler>[0]) => handler(r);
    ipcRenderer.on(ROUTINES_V2.fired, listener);
    return () => ipcRenderer.removeListener(ROUTINES_V2.fired, listener);
  },
  // Routine running indicator: emitted when a routine LLM session starts/finishes
  // C1: runningStarted payload enriched to { routineId, firedAt, title } so the
  // renderer can push a proper OverlayItem immediately without waiting for fired.
  onRoutineRunningStarted: (handler: (payload: { routineId: string; firedAt: string; title: string }) => void) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(ROUTINES_V2.runningStarted, listener);
    return () => ipcRenderer.removeListener(ROUTINES_V2.runningStarted, listener);
  },
  onRoutineRunningFinished: (handler: (routineId: string) => void) => {
    const listener = (_e: unknown, id: string) => handler(id);
    ipcRenderer.on(ROUTINES_V2.runningFinished, listener);
    return () => ipcRenderer.removeListener(ROUTINES_V2.runningFinished, listener);
  },
  // failed: emitted when the routine LLM session throws (e.g. provider error).
  // Without this bridge the renderer never learns the session failed and the
  // running OverlayItem stays stuck with running:true indefinitely.
  onRoutineFailedV2: (handler: (event: { routineId: string; error: string }) => void) => {
    const listener = (_e: unknown, payload: { routineId: string; error: string }) => handler(payload);
    ipcRenderer.on(ROUTINES_V2.failed, listener);
    return () => ipcRenderer.removeListener(ROUTINES_V2.failed, listener);
  },
  // Routine session history — unified conversation sessions scoped by routineId
  listRoutineSessionsV2: async (routineId: string, limit?: number) =>
    ipcRenderer.invoke(ROUTINES_V2.listSessions, routineId, limit) as Promise<
      Array<{ routineId: string; firedAt: string; sessionId: string; title: string; preview: string }>
    >,

  // Overlay IPC bridges (main → renderer push)
  onOverlayShow: (handler: (item: unknown) => void) => {
    const listener = (_e: unknown, item: unknown) => handler(item);
    ipcRenderer.on(OVERLAY_V1.show, listener);
    return () => ipcRenderer.removeListener(OVERLAY_V1.show, listener);
  },
  onOverlayUpdate: (handler: (id: string, patch: unknown) => void) => {
    const listener = (_e: unknown, id: string, patch: unknown) => handler(id, patch);
    ipcRenderer.on(OVERLAY_V1.update, listener);
    return () => ipcRenderer.removeListener(OVERLAY_V1.update, listener);
  },
  onOverlayDismiss: (handler: (id: string) => void) => {
    const listener = (_e: unknown, id: string) => handler(id);
    ipcRenderer.on(OVERLAY_V1.dismiss, listener);
    return () => ipcRenderer.removeListener(OVERLAY_V1.dismiss, listener);
  },

  // todo_session_write — assistant's current-turn checklist
  listSessionTodos: async (sessionId?: string) =>
    ipcRenderer.invoke("lvis:session-todo:list", sessionId),
  clearSessionTodos: async (sessionId?: string) =>
    ipcRenderer.invoke("lvis:session-todo:clear", sessionId),
  onSessionTodoChanged: (
    handler: (payload: {
      sessionId: string;
      items: SessionTodoItem[];
    }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on("lvis:session-todo:changed", listener);
    return () => ipcRenderer.removeListener("lvis:session-todo:changed", listener);
  },

  // agent_spawn — sub-agent lifecycle event stream
  onAgentSpawnEvent: (
    handler: (event: {
      spawnId: string;
      type: "start" | "turn" | "done" | "error";
      title?: string;
      turn?: number;
      text?: string;
      summary?: string;
      toolCallCount?: number;
      message?: string;
      toolUseId?: string;
    }) => void,
  ) => {
    const listener = (_e: unknown, ev: Parameters<typeof handler>[0]) => handler(ev);
    ipcRenderer.on("lvis:agent-spawn:event", listener);
    return () => ipcRenderer.removeListener("lvis:agent-spawn:event", listener);
  },

  // skill_load — chat-side badge event
  onSkillLoaded: (
    handler: (event: {
      name: string;
      description: string;
    }) => void,
  ) => {
    const listener = (_e: unknown, ev: Parameters<typeof handler>[0]) => handler(ev);
    ipcRenderer.on("lvis:skill-load:event", listener);
    return () => ipcRenderer.removeListener("lvis:skill-load:event", listener);
  },

  // ─── Notifications (#260) ────────────────────────
  // Main process pushes in-app toast payloads when the window is focused;
  // OS notifications fire when backgrounded/minimized. Renderer also signals
  // back when an in-app toast / OS notification is clicked so main can focus
  // the window and the renderer can scroll/navigate to the source surface.
  onNotificationToast: (
    handler: (payload: {
      kind: "turn-end" | "routine" | "ask-user" | "approval" | "plugin" | "system";
      title: string;
      body: string;
      contextRef?: {
        sessionId?: string;
        routineId?: string;
        questionId?: string;
        approvalId?: string;
      };
    }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on("lvis:notification:toast", listener);
    return () => ipcRenderer.removeListener("lvis:notification:toast", listener);
  },
  onNotificationClicked: (
    handler: (payload: {
      kind: "turn-end" | "routine" | "ask-user" | "approval" | "plugin" | "system";
      contextRef?: {
        sessionId?: string;
        routineId?: string;
        questionId?: string;
        approvalId?: string;
      };
    }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on("lvis:notification:clicked", listener);
    return () => ipcRenderer.removeListener("lvis:notification:clicked", listener);
  },
  notifyClick: async (payload: {
    kind: "turn-end" | "routine" | "ask-user" | "approval" | "plugin" | "system";
    contextRef?: {
      sessionId?: string;
      routineId?: string;
      questionId?: string;
      approvalId?: string;
    };
  }) => ipcRenderer.invoke("lvis:notification:clicked", payload),

  // ─── Window management (tab detach + optional magnetic snap) ─────────────
  window: {
    /** Open viewKey in a new detached BrowserWindow. */
    openDetached: async (viewKey: string) =>
      ipcRenderer.invoke("lvis:window:open-detached", viewKey) as Promise<
        { ok: true; windowId: number } | { ok: false; error: string }
      >,
    /** Close the current detached window (no-op in main window). */
    closeDetached: async () =>
      ipcRenderer.invoke("lvis:window:close-detached") as Promise<{ ok: true } | { ok: false; error: string }>,
    /** List all currently open detached windows. */
    listDetached: async () =>
      ipcRenderer.invoke("lvis:window:list-detached") as Promise<
        Array<{ windowId: number; viewKey: string; snapped: boolean }>
      >,
    loadSessionInMain: async (sessionId: string) =>
      ipcRenderer.invoke("lvis:window:load-session-in-main", sessionId) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    /** Open a render_html result in an isolated BrowserWindow. */
    openHtmlPreview: async (payload: OpenHtmlPreviewWindowPayload) =>
      ipcRenderer.invoke("lvis:window:open-html-preview", payload) as Promise<OpenHtmlPreviewWindowResult>,
    /**
     * Subscribe to snap-edge highlight events sent from the main process
     * when a child window enters/exits the snap zone.
     * edge: "n"|"s"|"e"|"w" when entering, null when leaving.
     */
    onSnapEdge: (handler: (edge: "n" | "s" | "e" | "w" | null) => void) => {
      const listener = (_event: unknown, edge: "n" | "s" | "e" | "w" | null) => handler(edge);
      ipcRenderer.on("lvis:window:snap-edge", listener);
      return () => ipcRenderer.removeListener("lvis:window:snap-edge", listener);
    },
    /**
     * Subscribe to in-place navigation events sent by WindowManager when a
     * second plugin is clicked while the detached shell is already open.
     * The detached shell calls this to swap its displayed content without
     * closing and reopening a window.
     */
    onDetachedNavigate: (handler: (viewKey: string) => void) => {
      const listener = (_event: unknown, payload: { viewKey?: string }) => {
        if (typeof payload?.viewKey === "string") handler(payload.viewKey);
      };
      ipcRenderer.on("lvis:detached:navigate", listener);
      return () => ipcRenderer.removeListener("lvis:detached:navigate", listener);
    },
    onLoadSessionInMain: (handler: (sessionId: string) => boolean | void | Promise<boolean | void>) => {
      const listener = (_event: unknown, payload: { sessionId?: unknown }) => {
        if (typeof payload?.sessionId !== "string") return;
        void Promise.resolve()
          .then(() => handler(payload.sessionId))
          .then((loaded) => {
            if (typeof (payload as { requestId?: unknown }).requestId !== "string") return;
            ipcRenderer.send("lvis:window:load-session-in-main-result", {
              requestId: (payload as { requestId: string }).requestId,
              ok: loaded !== false,
              ...(loaded === false ? { error: "load-session-failed" } : {}),
            });
          })
          .catch((err: unknown) => {
            if (typeof (payload as { requestId?: unknown }).requestId !== "string") return;
            ipcRenderer.send("lvis:window:load-session-in-main-result", {
              requestId: (payload as { requestId: string }).requestId,
              ok: false,
              error: err instanceof Error ? err.message : "load-session-failed",
            });
          });
      };
      ipcRenderer.on("lvis:window:load-session-in-main", listener);
      return () => ipcRenderer.removeListener("lvis:window:load-session-in-main", listener);
    },
  },

  /**
   * Dev tools bridge — only useful in non-production builds. Renderer
   * floating panel uses this to adjust the token preflight threshold
   * at runtime (so compact scenarios can be reproduced without filling
   * the actual model context window).
   */
  dev: {
    setPreflightOverride: async (tokens: number | null) =>
      ipcRenderer.invoke("lvis:dev:setPreflightOverride", tokens) as Promise<
        { ok: true; value: number | null } | { ok: false; error: string }
      >,
    getPreflightStatus: async () =>
      ipcRenderer.invoke("lvis:dev:getPreflightStatus") as Promise<
        | { ok: true; runtimeOverride: number | null; envOverride: number | null; effective: number; provider: string; model: string }
        | { ok: false; error: string }
      >,
  },
};

// Expose the theme prime payload so ThemeProvider (renderer) can read it
// synchronously on mount and skip its async settings.json hydrate. `null`
// when main has nothing cached yet (cold-boot first window). Frozen so the
// renderer cannot mutate it.
contextBridge.exposeInMainWorld("__lvisInitialTheme", lvisInitialTheme);

contextBridge.exposeInMainWorld("lvisApi", api);
// Dev mode runtime flag — main process sets NODE_ENV=development in
// `scripts/run-electron.mjs`, so preload reads it at runtime.
//
// IMPORTANT: webpack's production mode auto-injects DefinePlugin that
// statically replaces ANY recognizable `process.env.NODE_ENV` shape with
// the build-time value ("production") — including bracket notation
// `process.env["NODE_ENV"]`. To force a true runtime lookup we route the
// access through (a) a runtime-resolved key name and (b) `globalThis.process`
// indirection so neither AST root nor index matches DefinePlugin's pattern.
function readEnvAtRuntime(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.[name];
}
contextBridge.exposeInMainWorld(
  "__lvisDevMode",
  readEnvAtRuntime("NODE_ENV") !== "production",
);

let hostMarketplaceApiClaimed = false;
contextBridge.exposeInMainWorld("lvisHost", {
  takePluginMarketplaceApi: () => {
    if (hostMarketplaceApiClaimed) return null;
    hostMarketplaceApiClaimed = true;
    return {
      installMarketplacePlugin: async (pluginId: string, expectedVersion?: string) =>
        normalizePluginActionResult(await ipcRenderer.invoke("lvis:plugins:install", pluginId, expectedVersion ? { expectedVersion } : undefined)),
      uninstallMarketplacePlugin: async (pluginId: string) =>
        normalizePluginActionResult(await ipcRenderer.invoke("lvis:plugins:uninstall", pluginId)),
      installMarketplaceAgent: async (slug: string) =>
        normalizeMarketplacePackageActionResult(await ipcRenderer.invoke("lvis:agents:install", slug), "agentId"),
      uninstallMarketplaceAgent: async (slug: string) =>
        normalizeMarketplacePackageActionResult(await ipcRenderer.invoke("lvis:agents:uninstall", slug), "agentId"),
      installMarketplaceSkill: async (slug: string) =>
        normalizeMarketplacePackageActionResult(await ipcRenderer.invoke("lvis:skills:install", slug), "skillId"),
      uninstallMarketplaceSkill: async (slug: string) =>
        normalizeMarketplacePackageActionResult(await ipcRenderer.invoke("lvis:skills:uninstall", slug), "skillId"),
    };
  },
});

// ─── Window control bridge (custom titlebar) ─────────────────────────────
// Exposed unconditionally so the renderer can branch at runtime.
// On macOS the windowControl methods are never called (traffic lights
// are OS-managed). isDarwin lets the renderer suppress Win/Linux buttons.
contextBridge.exposeInMainWorld("lvisPlatform", {
  isDarwin: process.platform === "darwin",
});
contextBridge.exposeInMainWorld("lvisWindow", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
  close: () => ipcRenderer.invoke("window:close"),
  syncTitleBarTheme: (color: string, symbolColor: string) =>
    ipcRenderer.invoke("window:syncTitleBarTheme", { color, symbolColor }),
  onMaximizedChanged: (handler: (maximized: boolean) => void) => {
    const listener = (_event: unknown, maximized: boolean) => handler(maximized);
    ipcRenderer.on("window:maximizedChanged", listener);
    return () => ipcRenderer.removeListener("window:maximizedChanged", listener);
  },
  onFullscreenChanged: (handler: (fullscreen: boolean) => void) => {
    const listener = (_event: unknown, fullscreen: boolean) => handler(fullscreen);
    ipcRenderer.on("window:fullscreenChanged", listener);
    return () => ipcRenderer.removeListener("window:fullscreenChanged", listener);
  },
});

// ─── lvis 네임스페이스 (B1: Approval Gate + Permission) ──
// renderer에서 window.lvis.approval / window.lvis.permission으로 접근
contextBridge.exposeInMainWorld("lvis", {
  permission: api.permission,
  approval: api.approval,
  userApproval: api.userApproval,
  policy: api.policy,
  mcp: api.mcp,
  plugins: {
    cards: () => ipcRenderer.invoke("lvis:plugins:cards"),
  },
  ui: {
    showAssistantContextMenu: (payload: AssistantContextMenuPayload) =>
      ipcRenderer.invoke(UI.assistantContextMenu, payload),
    onAssistantContextAction: (cb: (action: AssistantContextMenuAction) => void) => {
      const listener = (_event: unknown, action: AssistantContextMenuAction) => cb(action);
      ipcRenderer.on(UI.assistantContextAction, listener);
      return () => ipcRenderer.removeListener(UI.assistantContextAction, listener);
    },
  },
  pluginConfig: {
    get: (pluginId: string) => ipcRenderer.invoke("lvis:plugins:config:get", pluginId),
    set: (pluginId: string, config: Record<string, unknown>) => ipcRenderer.invoke("lvis:plugins:config:set", pluginId, config),
    getSchema: (pluginId: string) => ipcRenderer.invoke("lvis:plugins:config:schema:get", pluginId),
    setSecret: (pluginId: string, key: string, value: string) =>
      ipcRenderer.invoke("lvis:plugins:config:secret:set", pluginId, key, value),
    // US-3c.1: batch secret-presence query — returns keys for which the
    // keychain holds a value. Fewer IPC round-trips than per-key checks.
    listSecretKeys: (pluginId: string) =>
      ipcRenderer.invoke("lvis:plugins:config:secret:list-keys", pluginId),
  },
  env: {
    isDev: process.env.LVIS_DEV === "1",
    isE2E: process.env.LVIS_E2E === "1",
    enableDevConsole: process.env.LVIS_DEV_CONSOLE === "1",
    debugStream:
      process.env.VITE_DEBUG_STREAM === "1" ||
      process.env.LVIS_DEBUG_STREAM === "1",
    /**
     * Legacy dev/debug surface only. Demo activation decisions now use
     * `api.demo.status()` because packaged builds scrub `LVIS_DEMO_*`
     * before preload inherits env.
     */
    demoVendor: typeof process.env.LVIS_DEMO_VENDOR === "string" ? process.env.LVIS_DEMO_VENDOR : null,
  },
  attach: {
    openFile: () => ipcRenderer.invoke("lvis:attach:openFile"),
    readImage: (filePath: string) =>
      ipcRenderer.invoke("lvis:attach:readImage", filePath),
    saveClipboardImage: (base64: string) =>
      ipcRenderer.invoke("lvis:attach:saveClipboardImage", { base64 }),
    openExternal: (filePath: string) =>
      ipcRenderer.invoke("lvis:attach:openExternal", filePath),
  },
});
