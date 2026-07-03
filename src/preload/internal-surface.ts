// internal-surface.ts — the internal (non-public) portion of the exposed preload
// APIs (#1409 + #1411 C11): settings, auth/demo/tour mockup, memory,
// plugin/agent/skill lifecycle, mcp, permission/policy/user-approval (the
// gesture-gated mutating family), audit/dlp, routines, work-board, overlay,
// notifications, window management, dev tools, plugin-frame bridges, and the
// theme/app-mode race-window primes. Consumes the SHARED gesture token via
// ./gesture-intent (`ipcUserKeyboardIntent`). Channel names come from the
// contract SOT (no inline literals).
import { ipcRenderer } from "electron";
import {
  CHANNELS,
  MARKETPLACE,
  OVERLAY_V1,
  PERMISSIONS,
  ROUTINES_V2,
  SETTINGS,
  UI,
  WORK_BOARD,
} from "../contract/app-contract.js";
import { t } from "../i18n/index.js";
import { ipcUserKeyboardIntent } from "./gesture-intent.js";
import { PLUGIN_PRIVATE_NAMESPACES } from "../plugins/capabilities.js";
import {
  INITIAL_THEME_ARG_PREFIX,
  INITIAL_THEME_ARG_MAX_BYTES,
  type InitialThemePrime,
} from "../shared/initial-theme.js";
import {
  FONT_SIZE_SCALE_VALUES,
  isValidFontFamilyOverride,
} from "../shared/appearance-font.js";
import {
  INITIAL_APP_MODE_ARG_PREFIX,
  normalizeAppMode,
  type InitialAppMode,
} from "../shared/initial-app-mode.js";
import type { McpServerConfig } from "../mcp/types.js";
import type {
  PermissionReviewSuggestionPayload,
  UserApprovalHitPayload,
  UserApprovalScope,
  UserApprovalVerdict,
} from "../shared/permissions-events.js";
import type { MarketplaceAnnouncementPayload } from "../shared/marketplace-announcements.js";
import type {
  AssistantContextMenuAction,
  AssistantContextMenuPayload,
} from "../shared/assistant-context-menu.js";
import type { AiProviderPingIpcResult } from "../shared/ai-provider-ping.js";
import type {
  OpenHtmlPreviewWindowPayload,
  OpenHtmlPreviewWindowResult,
} from "../shared/render-html-preview.js";
import type { SessionTodoItem } from "../shared/session-todo.js";
import type { StreamEvent, ChatEntry } from "../lib/chat-stream-state.js";
import type { SerializedHistoryMessage } from "../shared/chat-history.js";
import type { TurnResult } from "../engine/conversation-loop.js";

export type LvisInitialThemePayload = Readonly<InitialThemePrime>;

export function readInitialThemeArg(): LvisInitialThemePayload | null {
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
    const p = parsed as {
      bundleId?: unknown;
      shell?: unknown;
      tokens?: unknown;
      fontSizeScale?: unknown;
      fontFamily?: unknown;
    };
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
    // Font overrides are validated against the same SoT guards the settings
    // store enforces at write time (`FONT_SIZE_SCALE_VALUES`,
    // `isValidFontFamilyOverride`) so a tampered argv cannot inject an arbitrary
    // scale or a CSS-injection font-family. Invalid → field stays undefined and
    // the renderer's hydrate applies the persisted value.
    const out: InitialThemePrime = { bundleId: p.bundleId, shell: p.shell, tokens: Object.freeze(tokens) };
    if (
      typeof p.fontSizeScale === "number" &&
      (FONT_SIZE_SCALE_VALUES as readonly number[]).includes(p.fontSizeScale)
    ) {
      out.fontSizeScale = p.fontSizeScale;
    }
    if (isValidFontFamilyOverride(p.fontFamily)) {
      out.fontFamily = p.fontFamily;
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

export function applyInitialThemePrime(payload: LvisInitialThemePayload | null): void {
  if (!payload || typeof document === "undefined") return;
  // Apply attributes + tokens immediately. Preload's mutations to
  // documentElement are visible to the renderer's first paint because both
  // share the same DOM (contextIsolation isolates JS objects, not DOM).
  try {
    const root = document.documentElement;
    root.setAttribute("data-theme-bundle", payload.bundleId);
    root.setAttribute("data-shell", payload.shell);
    if (payload.tokens) {
      for (const [k, v] of Object.entries(payload.tokens)) {
        root.style.setProperty(k, v);
      }
    }
    // User font overrides — same documentElement CSS-var hooks ThemeProvider's
    // `applySettingsAppearance` sets after hydrate.
    if (typeof payload.fontSizeScale === "number") {
      root.style.setProperty("--lvis-font-size-scale", String(payload.fontSizeScale));
    }
    if (typeof payload.fontFamily === "string") {
      root.style.setProperty("--lvis-font-family", payload.fontFamily);
    }
  } catch {
    // Non-fatal: ThemeProvider's async hydrate still runs as a fallback.
  }
}

export function readInitialAppModeArg(): InitialAppMode | null {
  try {
    const arg = process.argv.findLast(
      (a): a is string => typeof a === "string" && a.startsWith(INITIAL_APP_MODE_ARG_PREFIX),
    );
    if (!arg) return null;
    const value = arg.slice(INITIAL_APP_MODE_ARG_PREFIX.length);
    return normalizeAppMode(value);
  } catch {
    return null;
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

export function buildInternalApiSurface() {
  return {
  // ─── Settings ────────────────────────────────────
  getSettings: async () => ipcRenderer.invoke(CHANNELS.settings.get),
  updateSettings: async (partial: unknown) => ipcRenderer.invoke(CHANNELS.settings.update, partial),
  applyHostMap: async (hostResolverMap: string) => ipcRenderer.invoke(SETTINGS.applyHostMap, hostResolverMap),
  onSettingsUpdated: (handler: (settings: unknown) => void) => {
    const listener = (_event: unknown, settings: unknown) => handler(settings);
    ipcRenderer.on(SETTINGS.updated, listener);
    return () => ipcRenderer.removeListener(SETTINGS.updated, listener);
  },
  setApiKey: async (vendor: string, apiKey: string) => ipcRenderer.invoke(CHANNELS.settings.setApiKey, vendor, apiKey),
  hasApiKey: async (vendor?: string) => ipcRenderer.invoke(CHANNELS.settings.hasApiKey, vendor) as Promise<boolean>,
  deleteApiKey: async (vendor: string) => ipcRenderer.invoke(CHANNELS.settings.deleteApiKey, vendor),
  setWebApiKey: async (provider: string, apiKey: string) => ipcRenderer.invoke(CHANNELS.settings.setWebApiKey, provider, apiKey),
  hasWebApiKey: async (provider: string) => ipcRenderer.invoke(CHANNELS.settings.hasWebApiKey, provider) as Promise<boolean>,
  deleteWebApiKey: async (provider: string) => ipcRenderer.invoke(CHANNELS.settings.deleteWebApiKey, provider),
  setMarketplaceApiKey: async (apiKey: string) => ipcRenderer.invoke(CHANNELS.settings.marketplaceSetApiKey, apiKey),
  hasMarketplaceApiKey: async () => ipcRenderer.invoke(CHANNELS.settings.marketplaceHasApiKey) as Promise<boolean>,
  deleteMarketplaceApiKey: async () => ipcRenderer.invoke(CHANNELS.settings.marketplaceDeleteApiKey),
  // #893 — top-level mockup credential login. Hard-coded `demo`/`demo123`
  // (env override via `LVIS_DEMO_USER` / `LVIS_DEMO_PASS`). Vendor is no
  // longer sent by the renderer; the backend picks via `LVIS_DEMO_VENDOR`
  // (default `"openai"`) and reports it back on success along with the
  // applied baseUrl/model/vertex config.
  loginMockup: async (payload: { username: string; password: string }) =>
    ipcRenderer.invoke(CHANNELS.auth.loginMockup, payload) as Promise<
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
      ipcRenderer.on(CHANNELS.auth.progress, listener);
      return () => ipcRenderer.removeListener(CHANNELS.auth.progress, listener);
    },
    // 2026-05-20 — Settings 가 별도 BrowserWindow 로 mount 되기 때문에 main
    // window 의 onboarding chain / LoginModal 에 직접 dispatch 하지 못한다.
    // `broadcast*` 는 main 에서 모든 window 로 fan-out 하는 cue, `on*` 은
    // main window 의 App.tsx 가 subscribe 하는 listener. payload 가 없다.
    broadcastLogoutReset: async () =>
      ipcRenderer.invoke(CHANNELS.auth.logoutBroadcast) as Promise<
        | { ok: true }
        | { ok: false; error: "unauthorized-frame" }
      >,
    broadcastReactivateDemo: async () =>
      ipcRenderer.invoke(CHANNELS.auth.reactivateBroadcast) as Promise<
        | { ok: true }
        | { ok: false; error: "unauthorized-frame" }
      >,
    onLogoutReset: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on(CHANNELS.auth.logoutReset, listener);
      return () => ipcRenderer.removeListener(CHANNELS.auth.logoutReset, listener);
    },
    onReactivateDemo: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on(CHANNELS.auth.reactivateDemo, listener);
      return () => ipcRenderer.removeListener(CHANNELS.auth.reactivateDemo, listener);
    },
  },
  // ─── Interactive PTY terminal (#1444) ────────────────
  // Host-renderer-only surface. spawn/input/resize/kill are invokes; onData /
  // onExit subscribe to main→renderer events and return an unsubscribe fn (the
  // settings.updated / auth.progress pattern). All channels are INTERNAL — an
  // external origin can never reach them (fail-closed isPublicChannel).
  terminal: {
    spawn: async (payload: { tabId: string; cwd?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke(CHANNELS.terminal.spawn, payload) as Promise<
        | { ok: true; tabId: string; replayed: boolean }
        | { ok: false; reason: string; message: string }
      >,
    input: async (tabId: string, data: string) =>
      ipcRenderer.invoke(CHANNELS.terminal.input, { tabId, data }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    resize: async (tabId: string, cols: number, rows: number) =>
      ipcRenderer.invoke(CHANNELS.terminal.resize, { tabId, cols, rows }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    kill: async (tabId: string) =>
      ipcRenderer.invoke(CHANNELS.terminal.kill, { tabId }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    onData: (handler: (payload: { tabId: string; chunk: string }) => void) => {
      const listener = (_event: unknown, payload: { tabId?: unknown; chunk?: unknown }) => {
        if (typeof payload?.tabId !== "string" || typeof payload?.chunk !== "string") return;
        handler({ tabId: payload.tabId, chunk: payload.chunk });
      };
      ipcRenderer.on(CHANNELS.terminal.data, listener);
      return () => ipcRenderer.removeListener(CHANNELS.terminal.data, listener);
    },
    onExit: (handler: (payload: { tabId: string; exitCode: number; signal?: number }) => void) => {
      const listener = (
        _event: unknown,
        payload: { tabId?: unknown; exitCode?: unknown; signal?: unknown },
      ) => {
        if (typeof payload?.tabId !== "string" || typeof payload?.exitCode !== "number") return;
        handler({
          tabId: payload.tabId,
          exitCode: payload.exitCode,
          ...(typeof payload?.signal === "number" ? { signal: payload.signal } : {}),
        });
      };
      ipcRenderer.on(CHANNELS.terminal.exit, listener);
      return () => ipcRenderer.removeListener(CHANNELS.terminal.exit, listener);
    },
  },
  // ─── Side chat (workspace rail) ──────────────────────
  // A second, independently-streaming chat session. send/new/load/list/abort
  // are invokes; onStream/onFallback subscribe to the DEDICATED
  // CHANNELS.sidechat.{stream,fallback} events (NOT chat.stream) and return an
  // unsubscribe fn (the onChatStream pattern). All channels are INTERNAL — an
  // external origin can never reach them (fail-closed isPublicChannel).
  sideChat: {
    send: async (input: string, attachments?: unknown[]) =>
      ipcRenderer.invoke(CHANNELS.sidechat.send, { input, attachments }) as Promise<
        | { ok: true; result: TurnResult }
        | { ok: false; error: string }
      >,
    new: async () =>
      ipcRenderer.invoke(CHANNELS.sidechat.new) as Promise<
        | { ok: true; sessionId: string }
        | { ok: false; error: string }
      >,
    load: async (sessionId: string) =>
      ipcRenderer.invoke(CHANNELS.sidechat.load, sessionId) as Promise<
        | { ok: true; sessionId: string; messages: SerializedHistoryMessage[] }
        | { ok: false; error: string; messages: SerializedHistoryMessage[] }
      >,
    list: async () =>
      ipcRenderer.invoke(CHANNELS.sidechat.list) as Promise<{
        current: string | null;
        sessions: Array<{ id: string; modifiedAt: string; title: string }>;
      }>,
    abort: async () =>
      ipcRenderer.invoke(CHANNELS.sidechat.abort) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    onStream: (handler: (event: StreamEvent) => void) => {
      const listener = (_event: unknown, payload: StreamEvent) => handler(payload);
      ipcRenderer.on(CHANNELS.sidechat.stream, listener);
      return () => ipcRenderer.removeListener(CHANNELS.sidechat.stream, listener);
    },
    onFallback: (handler: (payload: { from: string; to: string }) => void) => {
      const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
      ipcRenderer.on(CHANNELS.sidechat.fallback, listener);
      return () => ipcRenderer.removeListener(CHANNELS.sidechat.fallback, listener);
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
      ipcRenderer.invoke(CHANNELS.demo.status) as Promise<
        | { ok: true; activated: boolean; vendor: string | null; autoActivatable: boolean }
        | { ok: false; error: "unauthorized-frame" }
      >,
    activate: async (code: string) =>
      ipcRenderer.invoke(CHANNELS.demo.activate, { code }) as Promise<
        | { ok: true; vendor: string; requiresRelaunch?: boolean }
        | { ok: false; error: "invalid-code" | "no-vendor" | "invalid-vendor" | "no-demo-key" | "missing-foundry-endpoint" | "invalid-foundry-endpoint" | "missing-foundry-host-map" | "foundry-host-map-mismatch" | "invalid-foundry-host-map-target" | "persist-failed" | "unauthorized-frame" }
      >,
    // Embedded activation — same decrypt→validate→persist chain as
    // `activate`, but the code string is the build-time embedded key
    // (`status.autoActivatable === true` advertises it). `no-embedded-code`
    // routes the renderer back to the manual paste input.
    activateEmbedded: async () =>
      ipcRenderer.invoke(CHANNELS.demo.activateEmbedded) as Promise<
        | { ok: true; vendor: string; requiresRelaunch?: boolean }
        | { ok: false; error: "no-embedded-code" | "invalid-code" | "no-vendor" | "invalid-vendor" | "no-demo-key" | "missing-foundry-endpoint" | "invalid-foundry-endpoint" | "missing-foundry-host-map" | "foundry-host-map-mismatch" | "invalid-foundry-host-map-target" | "persist-failed" | "unauthorized-frame" }
      >,
    relaunchAfterActivation: async () =>
      ipcRenderer.invoke(CHANNELS.demo.relaunchAfterActivation) as Promise<
        | { ok: true }
        | { ok: false; error: "not-armed" | "unauthorized-frame" }
      >,
    // 2026-05-20 — Settings 의 로그아웃 path. .env.demo 파일 + process.env
    // LVIS_DEMO_* + captured demo state 를 한 번에 비워 다음 `status` 호출이
    // `activated=false` 를 반환하도록 한다.
    clearDemo: async () =>
      ipcRenderer.invoke(CHANNELS.demo.clear) as Promise<
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
      ipcRenderer.invoke(CHANNELS.tour.getState) as Promise<
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
      ipcRenderer.invoke(CHANNELS.tour.markComplete, { scenarioId }) as Promise<
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
      ipcRenderer.invoke(CHANNELS.tour.dismiss, { scenarioId }) as Promise<
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
      ipcRenderer.invoke(CHANNELS.tour.start, { scenarioId }) as Promise<
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
      ipcRenderer.on(CHANNELS.tour.start, listener);
      return () => ipcRenderer.removeListener(CHANNELS.tour.start, listener);
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
      CHANNELS.plugins.install,
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
    ipcRenderer.invoke(CHANNELS.onboarding.contextSet, { content }) as Promise<
      | { ok: true }
      | { ok: false; error: string; message: string }
    >,
  openSettingsWindow: async (initialTab?: string) =>
    ipcRenderer.invoke(CHANNELS.settingsWindow.open, initialTab) as Promise<
      { ok: true; windowId: number } | { ok: false; error: string }
    >,
  notifySettingsWindowSaved: async () =>
    ipcRenderer.invoke(CHANNELS.settingsWindow.saved) as Promise<{ ok: true } | { ok: false; error: string }>,
  onSettingsWindowSaved: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on(CHANNELS.settingsWindow.saved, listener);
    return () => ipcRenderer.removeListener(CHANNELS.settingsWindow.saved, listener);
  },
  onSettingsWindowTab: (handler: (initialTab: string) => void) => {
    const listener = (_event: unknown, payload: { initialTab?: unknown }) => {
      if (typeof payload?.initialTab === "string") handler(payload.initialTab);
    };
    ipcRenderer.on(CHANNELS.settingsWindow.tab, listener);
    return () => ipcRenderer.removeListener(CHANNELS.settingsWindow.tab, listener);
  },
  // Open an http(s) URL in the system browser. Main-side validates the
  // scheme and rejects file://, javascript:, and any other handler.
  openExternalUrl: async (url: string) =>
    ipcRenderer.invoke(CHANNELS.shell.openExternal, url) as Promise<{
      ok: boolean;
      error?: string;
      protocol?: string;
      message?: string;
    }>,
  // #FU259 — MCP marketplace catalog + install
  listMcpCatalog: async () => ipcRenderer.invoke(CHANNELS.mcp.catalogList),
  installMcpFromMarketplace: async (slug: string) =>
    ipcRenderer.invoke(CHANNELS.mcp.installFromMarketplace, slug),
  // #FU262 — Claude Desktop config import (two-phase: preview → apply).
  previewClaudeDesktopMcpImport: async (raw: string) =>
    ipcRenderer.invoke(CHANNELS.mcp.importClaudeDesktopPreview, raw),
  applyClaudeDesktopMcpImport: async (payload: { raw: string; conflictPolicy?: "skip" | "overwrite" }) =>
    ipcRenderer.invoke(CHANNELS.mcp.importClaudeDesktopApply, payload),

  notifyPluginTheme: (payload: {
    bundleId: string;
    shell: "light" | "dark";
    tokens: Record<string, string>;
  }) =>
    ipcRenderer.invoke(CHANNELS.host.pluginThemeNotify, payload),

  // Plugin-owned OAuth removed host-owned provider auth IPC bridges.
  // 플러그인이 자체 인증을 소유한다.


  // ─── Memory ──────────────────────────────────────
  memoryListEntries: async () => ipcRenderer.invoke(CHANNELS.memory.entriesList),
  memorySaveEntry: async (title: string, content: string) => ipcRenderer.invoke(CHANNELS.memory.entriesSave, title, content),
  memoryDeleteEntry: async (filename: string) => ipcRenderer.invoke(CHANNELS.memory.entriesDelete, filename),
  memorySearchEntries: async (query: string) => ipcRenderer.invoke(CHANNELS.memory.entriesSearch, query),
  memoryGetIndex: async () => ipcRenderer.invoke(CHANNELS.memory.indexGet) as Promise<string>,
  memoryUpdateIndexIfUnchanged: async (expectedContent: string, nextContent: string) =>
    ipcRenderer.invoke(CHANNELS.memory.indexUpdateIfUnchanged, expectedContent, nextContent) as Promise<boolean>,
  memoryUpdateIndexSections: async (sections: { urgentMemory?: string; references?: string }) =>
    ipcRenderer.invoke(CHANNELS.memory.indexSectionsUpdate, sections),
  memoryListSessions: async () => ipcRenderer.invoke(CHANNELS.memory.sessionsList),
  memorySearchSessions: async (query: string) => ipcRenderer.invoke(CHANNELS.memory.sessionsSearch, query),
  memoryGetAgentsMd: async () => ipcRenderer.invoke(CHANNELS.memory.agentsMdGet) as Promise<string>,
  memoryUpdateAgentsMd: async (content: string) => ipcRenderer.invoke(CHANNELS.memory.agentsMdUpdate, content),
  memoryGetUserPrefs: async () => ipcRenderer.invoke(CHANNELS.memory.userPrefsGet) as Promise<string>,
  memoryUpdateUserPrefs: async (content: string) => ipcRenderer.invoke(CHANNELS.memory.userPrefsUpdate, content),
  memoryRefreshUserPrefs: async () => ipcRenderer.invoke(CHANNELS.memory.userPrefsRefresh),

  // ─── Plugins ─────────────────────────────────────
  listPersonaPromptSummaries: async () => ipcRenderer.invoke(CHANNELS.prompts.listSummaries),
  listPersonaPrompts: async () => ipcRenderer.invoke(CHANNELS.prompts.list),
  savePersonaPrompt: async (prompt: { id: string; name: string; systemPromptAdd: string }) =>
    ipcRenderer.invoke(CHANNELS.prompts.save, prompt),
  deletePersonaPrompt: async (id: string) => ipcRenderer.invoke(CHANNELS.prompts.delete, id),
  listAgentProfiles: async () => ipcRenderer.invoke(CHANNELS.agents.list),
  listSkills: async () => ipcRenderer.invoke(CHANNELS.skills.list),
  installAgentFromMarketplace: async (slug: string) =>
    ipcRenderer.invoke(CHANNELS.agents.install, slug),
  uninstallAgentPackage: async (slug: string) =>
    ipcRenderer.invoke(CHANNELS.agents.uninstall, slug),
  installSkillFromMarketplace: async (slug: string) =>
    ipcRenderer.invoke(CHANNELS.skills.install, slug),
  uninstallSkillPackage: async (slug: string) =>
    ipcRenderer.invoke(CHANNELS.skills.uninstall, slug),
  listPluginUiExtensions: async () => ipcRenderer.invoke(CHANNELS.plugins.uiList),
  // #237 — host renderer pre-binds (webContents.id → pluginId, entryUrl)
  // before each plugin webview navigates. Main rejects unknown pluginId
  // and any non-host frame.
  registerPluginWebview: async (payload: { webContentsId: number; pluginId: string; entryUrl: string }) =>
    ipcRenderer.invoke(CHANNELS.pluginBridge.registerWebview, payload) as Promise<{ ok: boolean; error?: string }>,
  readPluginUiModule: async (pluginId: string, viewId: string) =>
    ipcRenderer.invoke(CHANNELS.plugins.uiReadModule, { pluginId, viewId }) as Promise<string>,
  // #1176 — toggle a plugin active/inactive. Returns the IPC result frame
  // ({ ok, pluginId, enabled } | { ok:false, error, message }).
  setPluginEnabled: async (pluginId: string, enabled: boolean) =>
    ipcRenderer.invoke(CHANNELS.plugins.setEnabled, pluginId, enabled),
  callPluginMethod: async (
    method: string,
    payload?: unknown,
    options?: { userAction?: boolean },
  ) => ipcRenderer.invoke(CHANNELS.plugins.call, method, payload, {
    userAction: options?.userAction === true && navigator.userActivation?.isActive === true,
  }),


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
    ipcRenderer.on(CHANNELS.trigger.started, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.started, listener);
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
    ipcRenderer.on(CHANNELS.trigger.completed, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.completed, listener);
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
    ipcRenderer.on(CHANNELS.trigger.failed, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.failed, listener);
  },
  onTriggerExpired: (
    handler: (payload: { sessionId: string; pluginId: string; source: string }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.trigger.expired, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.expired, listener);
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
    ipcRenderer.on(CHANNELS.trigger.imported, listener);
    return () => ipcRenderer.removeListener(CHANNELS.trigger.imported, listener);
  },
  dismissTrigger: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.trigger.dismiss, sessionId) as Promise<{
      ok: boolean;
      removed?: boolean;
      error?: string;
    }>,
  importTrigger: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.trigger.import, sessionId) as Promise<{
      ok: boolean;
      imported?: number;
      reason?: string;
      error?: string;
    }>,

  // ─── Marketplace update notifications (S8) ───────
  onMarketplaceUpdatesAvailable: (handler: (updates: Array<{
    pluginId: string;
    pluginName?: string;
    installedVersion: string;
    latestVersion: string;
    networkAccess?: {
      allowedDomains: string[];
      reasoning?: string;
      allowPrivateNetworks?: boolean;
    };
  }>) => void) => {
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
    handler: (state: import("../shared/update-state.js").UpdateState) => void,
  ) => {
    const listener = (_event: unknown, state: Parameters<typeof handler>[0]) => handler(state);
    ipcRenderer.on(CHANNELS.update.state, listener);
    return () => ipcRenderer.removeListener(CHANNELS.update.state, listener);
  },
  /** Fetch the last-known state synchronously (for late-mounting components
   *  that miss the initial broadcast). Returns { kind: "idle" } before the
   *  first check completes. */
  getAppUpdateState: () =>
    ipcRenderer.invoke(CHANNELS.update.getState) as Promise<
      import("../shared/update-state.js").UpdateState
    >,
  /** Start the actual download. Only valid when the current state is
   *  "available"; rejected (ok:false) otherwise. */
  downloadAppUpdate: () =>
    ipcRenderer.invoke(CHANNELS.update.downloadNow) as Promise<{ ok: boolean; reason?: string }>,
  /** Quit and apply the downloaded update. Main validates the sender and
   *  owns the native confirmation dialog before it calls quitAndInstall().
   *  Only valid when the current state is "downloaded"; rejected
   *  (ok:false) otherwise. */
  installAppUpdate: () =>
    ipcRenderer.invoke(CHANNELS.update.installNow) as Promise<{ ok: boolean; reason?: string }>,
  skipAppUpdate: () =>
    ipcRenderer.invoke(CHANNELS.update.skipVersion) as Promise<{ ok: boolean; reason?: string }>,

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
    ipcRenderer.on(CHANNELS.bootstrap.status, listener);
    return () => ipcRenderer.removeListener(CHANNELS.bootstrap.status, listener);
  },
  // Banner-driven retry. Re-emits the start/complete/error
  // status sequence so the banner subscriber updates without needing a
  // separate result channel.
  retryBootstrap: () => ipcRenderer.invoke(CHANNELS.bootstrap.retry),

  // ─── lvis:// deep-link install lifecycle ─────────
  // Fires when a marketplace install triggered via lvis://install/{slug} has
  // finished installing + restartAll() in the main process. Renderer uses
  // this to refresh its plugin UI list so newly-installed plugin views
  // appear without requiring an app restart.
  onPluginInstallResult: (handler: (payload: { slug: string; success: boolean; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.plugins.installResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.plugins.installResult, listener);
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
    const r = await ipcRenderer.invoke(CHANNELS.plugins.installLocal) as
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
    ipcRenderer.on(CHANNELS.plugins.uninstallResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.plugins.uninstallResult, listener);
  },
  // #1176 — fires after a plugin's active/inactive state is toggled (via this
  // surface or any other). Renderer surfaces use this to refresh plugin cards
  // so a disabled plugin's tools/UI disappear (and reappear on re-enable).
  onPluginEnabledChanged: (handler: (payload: { pluginId: string; enabled: boolean }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.plugins.enabledChanged, listener);
    return () => ipcRenderer.removeListener(CHANNELS.plugins.enabledChanged, listener);
  },
  onPluginRuntimeUpdated: (handler: (payload: { pluginId: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.plugins.runtimeUpdated, listener);
    return () => ipcRenderer.removeListener(CHANNELS.plugins.runtimeUpdated, listener);
  },
  onPersonaPromptsUpdated: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on(CHANNELS.prompts.updated, listener);
    return () => ipcRenderer.removeListener(CHANNELS.prompts.updated, listener);
  },

  onAgentInstallResult: (handler: (payload: { slug: string; success: boolean; agentId?: string; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.agents.installResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.agents.installResult, listener);
  },
  onAgentUninstallResult: (handler: (payload: { slug: string; success: boolean; agentId?: string; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.agents.uninstallResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.agents.uninstallResult, listener);
  },
  onSkillInstallResult: (handler: (payload: { slug: string; success: boolean; skillId?: string; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.skills.installResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.skills.installResult, listener);
  },
  onSkillUninstallResult: (handler: (payload: { slug: string; success: boolean; skillId?: string; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.skills.uninstallResult, listener);
    return () => ipcRenderer.removeListener(CHANNELS.skills.uninstallResult, listener);
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
    ipcRenderer.on(CHANNELS.plugins.installProgress, listener);
    return () => ipcRenderer.removeListener(CHANNELS.plugins.installProgress, listener);
  },
  onAgentInstallProgress: (handler: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.agents.installProgress, listener);
    return () => ipcRenderer.removeListener(CHANNELS.agents.installProgress, listener);
  },
  onSkillInstallProgress: (handler: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.skills.installProgress, listener);
    return () => ipcRenderer.removeListener(CHANNELS.skills.installProgress, listener);
  },

  // Status bar — aggregated runtime counters (tools / plugins / mcps).
  getRuntimeCounts: async () =>
    ipcRenderer.invoke(CHANNELS.runtime.counts) as Promise<{
      tools: number;
      plugins: number;
      mcps: number;
    }>,
  // Status bar — static environment info (platform / hostname / user).
  // Static enough to fetch once on mount; values don't change while the
  // process is alive. Cwd is intentionally NOT exposed — least-privilege
  // for plugin UI panels that share this contextBridge.
  getRuntimeEnv: async () =>
    ipcRenderer.invoke(CHANNELS.runtime.env) as Promise<{
      platform: string;
      hostname: string;
      user: string;
    }>,
  // Status bar — marketplace reachability probe. Returns `configured: false`
  // when the user is on the mock backend (nothing to ping).
  pingMarketplace: async () =>
    ipcRenderer.invoke(CHANNELS.marketplace.ping) as Promise<{
      configured: boolean;
      online: boolean;
    }>,
  // Status bar — active LLM provider reachability probe. This performs a
  // tiny one-shot model call from the main process so "connected" means the
  // provider itself answered, not only that the marketplace backend is online.
  pingAiProvider: async () =>
    ipcRenderer.invoke(CHANNELS.llm.ping) as Promise<AiProviderPingIpcResult>,

  // Settings "일반" dashboard — host metadata. SoT for `version` is the
  // LVIS project package.json (resolved by the main process via
  // `app.getAppPath()`); stack fields come from `process.versions`. The
  // renderer never hard-codes these values.
  getAppInfo: async () =>
    ipcRenderer.invoke(CHANNELS.app.info) as Promise<{
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
    ipcRenderer.on(CHANNELS.pluginBridge.event, listener);
    return () => ipcRenderer.removeListener(CHANNELS.pluginBridge.event, listener);
  },

  // ─── MCP ─────────────────────────────────────────
  mcp: {
    servers: async () => ipcRenderer.invoke(CHANNELS.mcp.servers),
    kill: async (id: string) => ipcRenderer.invoke(CHANNELS.mcp.kill, id),
    getConfigs: async () => ipcRenderer.invoke(CHANNELS.mcp.configGet),
    getConfigPath: async () => ipcRenderer.invoke(CHANNELS.mcp.configPath),
    addConfig: async (config: McpServerConfig) => ipcRenderer.invoke(CHANNELS.mcp.configAdd, config),
    setApiKey: async (id: string, apiKey: string) => ipcRenderer.invoke(CHANNELS.mcp.configSetApiKey, id, apiKey),
    removeConfig: async (id: string) => ipcRenderer.invoke(CHANNELS.mcp.configRemove, id),
    readUiResource: async (serverId: string, uri: string) => ipcRenderer.invoke(CHANNELS.mcp.uiResource, serverId, uri) as Promise<string>,
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
    /** Read-only: honest OS sandbox capability for the current platform. */
    sandboxCapability: async () => ipcRenderer.invoke(PERMISSIONS.sandboxCapability),
    /** Read-only: Windows srt-win install readiness (group + WFP + instructions). */
    sandboxWindowsStatus: async () => ipcRenderer.invoke(PERMISSIONS.sandboxWindowsStatus),
    /**
     * MUTATING: trigger the one-time Windows srt-win install (one self-elevating
     * UAC prompt). The ONLY user-consented privilege-escalation entry point —
     * only ever called from an explicit "Install now" click. Auto-injects the
     * user-keyboard intent the sender-guarded handler requires.
     */
    sandboxWindowsInstall: async () =>
      ipcRenderer.invoke(PERMISSIONS.sandboxWindowsInstall, { intent: ipcUserKeyboardIntent() }),
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
    onReviewSuggestion: (cb: (payload: PermissionReviewSuggestionPayload) => void) => {
      const listener = (_event: unknown, payload: PermissionReviewSuggestionPayload) =>
        cb(payload);
      ipcRenderer.on(PERMISSIONS.reviewSuggestion, listener);
      return () =>
        ipcRenderer.removeListener(PERMISSIONS.reviewSuggestion, listener);
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
      ipcRenderer.on(CHANNELS.approval.request, listener);
      return () => ipcRenderer.removeListener(CHANNELS.approval.request, listener);
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
    getStats: async (days: number) => ipcRenderer.invoke(CHANNELS.dlp.stats, days),
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
    }) => ipcRenderer.invoke(CHANNELS.audit.search, filter),
    getStats: async (lastDays: number) => ipcRenderer.invoke(CHANNELS.audit.stats, lastDays),
  },

  // ─── Message feedback ────────────────────────────
  submitFeedback: async (payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) =>
    ipcRenderer.invoke(CHANNELS.feedback.submit, payload) as Promise<{ ok: boolean; error?: string }>,

  // ─── View Events ─────────────────────────────────
  onViewActivate: (handler: (viewKey: string) => void) => {
    const listener = (_event: unknown, payload: { viewKey?: string }) => handler(payload?.viewKey ?? "home");
    ipcRenderer.on(CHANNELS.view.activate, listener);
    return () => ipcRenderer.removeListener(CHANNELS.view.activate, listener);
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
      }>;
      createdAt: number;
    }) => void,
  ) => {
    const listener = (_e: unknown, req: Parameters<typeof handler>[0]) => handler(req);
    ipcRenderer.on(CHANNELS.askUserQuestion.request, listener);
    return () => ipcRenderer.removeListener(CHANNELS.askUserQuestion.request, listener);
  },
  respondAskUserQuestion: async (response: {
    requestId: string;
    answers?: Array<{ choice?: string; choices?: string[]; freeText?: string }>;
    dismissed?: boolean;
  }) => ipcRenderer.invoke(CHANNELS.askUserQuestion.respond, response),
  // Timeout side-channel — main process notifies the renderer when an
  // ask_user_question request expired (5 min default) so the card can drop
  // the stale prompt before the user clicks into a no-op.
  onAskUserQuestionTimeout: (
    handler: (payload: { requestId: string }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on(CHANNELS.askUserQuestion.timeout, listener);
    return () => ipcRenderer.removeListener(CHANNELS.askUserQuestion.timeout, listener);
  },

  // routine_schedule v2 — persistent routine list + lifecycle
  listRoutinesV2: async () => ipcRenderer.invoke(ROUTINES_V2.list),
  dismissRoutineV2: async (id: string) => ipcRenderer.invoke(ROUTINES_V2.dismiss, id),
  removeRoutineV2: async (id: string) => ipcRenderer.invoke(ROUTINES_V2.remove, id),
  triggerRoutineNowV2: async (id: string) => ipcRenderer.invoke(ROUTINES_V2.triggerNow, id),
  listPendingRoutineResultsV2: async () =>
    ipcRenderer.invoke(ROUTINES_V2.pendingResults) as Promise<
      import("../shared/routines-types.js").RoutineFiredPayload[]
    >,
  acknowledgeRoutineResultV2: async (routineId: string, firedAt: string) =>
    ipcRenderer.invoke(ROUTINES_V2.acknowledgeResult, routineId, firedAt) as Promise<{ ok: boolean; error?: string }>,
  addRoutineV2: async (input: import("../shared/routines-types.js").AddRoutineInput) =>
    ipcRenderer.invoke(ROUTINES_V2.add, input) as Promise<
      { ok: true; routine: import("../shared/routines-types.js").RoutineRecord } | { ok: false; error: string }
    >,
  onRoutineFiredV2: (
    handler: (event: import("../shared/routines-types.js").RoutineFiredPayload) => void,
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

  // ─── Work Board ──────────────────────────────────
  // Personal board CRUD + lifecycle. Each method maps 1:1 to a WORK_BOARD.*
  // channel; the main-process store returns discriminated `status` envelopes
  // (or `{ ok:false, error }` for unauthorized-frame / no-store), forwarded
  // verbatim — no fallback / re-shaping. Shared payload + result types come
  // from the renderer-safe `shared/work-board-types.js` (no Node built-ins).
  listWorkBoard: async (filter?: import("../shared/work-board-types.js").WorkItemListFilter) =>
    ipcRenderer.invoke(WORK_BOARD.list, filter) as Promise<
      | import("../shared/work-board-types.js").WorkItemListResult
      | { ok: false; error: string }
    >,
  getWorkBoardItem: async (id: number) =>
    ipcRenderer.invoke(WORK_BOARD.get, id) as Promise<
      | import("../shared/work-board-types.js").WorkItemGetResult
      | { ok: false; error: string }
    >,
  addWorkBoardItem: async (input: import("../shared/work-board-types.js").WorkItemCreateInput) =>
    ipcRenderer.invoke(WORK_BOARD.add, input) as Promise<
      | import("../shared/work-board-types.js").WorkItemCreateResult
      | { ok: false; error: string }
    >,
  updateWorkBoardItem: async (id: number, patch: import("../shared/work-board-types.js").WorkItemUpdateInput) =>
    ipcRenderer.invoke(WORK_BOARD.update, id, patch) as Promise<
      | import("../shared/work-board-types.js").WorkItemUpdateResult
      | { ok: false; error: string }
    >,
  transitionWorkBoardItem: async (id: number, to: import("../shared/work-board-types.js").WorkItemStatusStored) =>
    ipcRenderer.invoke(WORK_BOARD.transition, id, to) as Promise<
      | import("../shared/work-board-types.js").WorkItemTransitionResult
      | { ok: false; error: string }
    >,
  completeWorkBoardItem: async (id: number) =>
    ipcRenderer.invoke(WORK_BOARD.complete, id) as Promise<
      | import("../shared/work-board-types.js").WorkItemCompleteResult
      | { ok: false; error: string }
    >,
  reopenWorkBoardItem: async (id: number) =>
    ipcRenderer.invoke(WORK_BOARD.reopen, id) as Promise<
      | import("../shared/work-board-types.js").WorkItemReopenResult
      | { ok: false; error: string }
    >,
  removeWorkBoardItem: async (id: number) =>
    ipcRenderer.invoke(WORK_BOARD.remove, id) as Promise<
      | import("../shared/work-board-types.js").WorkItemDeleteResult
      | { ok: false; error: string }
    >,
  // Board view live refresh: emitted by the work-board IPC domain after any
  // successful mutation (created/updated/transitioned/completed/reopened/
  // removed) so the renderer board view re-lists without polling.
  onWorkBoardItemChanged: (
    handler: (payload: import("../shared/work-board-types.js").WorkItemChangedEventPayload) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.itemChanged, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.itemChanged, listener);
  },
  // Agent-orchestration run: kick off plan→approve→execute for one item. The
  // promise resolves with the terminal WorkItemRunResult, but live phase
  // updates flow over onWorkBoardRunProgress; coarse started/finished/failed
  // markers (for the per-item running indicator) flow over the on* siblings.
  // `opts.agentName` selects a named agent profile (drives the child model).
  runWorkBoardItem: async (id: number, opts?: { agentName?: string }) =>
    ipcRenderer.invoke(WORK_BOARD.run, id, opts) as Promise<
      | import("../shared/work-board-types.js").WorkItemRunResult
      | { ok: false; error: string }
    >,
  // Generate a daily / weekly personal work report from the board state +
  // activity log + learned memory. Resolves with the report markdown (ok),
  // an empty-period envelope, an error envelope (LLM failure), or no-reporter.
  generateWorkBoardReport: async (
    kind: "daily" | "weekly",
    input?: { date?: string; weekIso?: string; weekOffset?: number },
  ) =>
    ipcRenderer.invoke(WORK_BOARD.generateReport, kind, input) as Promise<
      | import("../shared/work-board-types.js").WorkBoardReportResult
      | { ok: false; error: string }
    >,
  // Read a past run's persisted transcript (plan+execute conversation) for the
  // run-history view. Resolves with the ordered events (empty when absent).
  getWorkBoardRunTranscript: async (itemId: number, runId: string) =>
    ipcRenderer.invoke(WORK_BOARD.runTranscript, itemId, runId) as Promise<
      | { events: import("../shared/work-board-types.js").RunTranscriptEvent[] }
      | { ok: false; error: string }
    >,
  // Live per-phase progress for an in-flight run (planning / awaiting_approval /
  // executing / denied / done / error). Payload === the engine's
  // WorkBoardRunEvent (aliased as RunProgressEventPayload).
  onWorkBoardRunProgress: (
    handler: (payload: import("../shared/work-board-types.js").RunProgressEventPayload) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runProgress, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runProgress, listener);
  },
  // Coarse marker: a run started for `itemId` (renderer sets the running flag).
  onWorkBoardRunStarted: (
    handler: (payload: { itemId: number; at: string }) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runStarted, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runStarted, listener);
  },
  // Coarse marker: a run finished for `itemId` with a terminal status (renderer
  // clears the running flag). `status` mirrors WorkItemRunResult.status.
  onWorkBoardRunFinished: (
    handler: (payload: {
      itemId: number;
      status: "completed" | "denied" | "not_found" | "error" | "already_running";
      at: string;
    }) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runFinished, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runFinished, listener);
  },
  // Coarse marker: the engine threw before producing a result (renderer clears
  // the running flag and surfaces `reason`).
  onWorkBoardRunFailed: (
    handler: (payload: { itemId: number; reason: string; at: string }) => void,
  ) => {
    const listener = (_e: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(WORK_BOARD.runFailed, listener);
    return () => ipcRenderer.removeListener(WORK_BOARD.runFailed, listener);
  },

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
    ipcRenderer.invoke(CHANNELS.sessionTodo.list, sessionId),
  clearSessionTodos: async (sessionId?: string) =>
    ipcRenderer.invoke(CHANNELS.sessionTodo.clear, sessionId),
  onSessionTodoChanged: (
    handler: (payload: {
      sessionId: string;
      items: SessionTodoItem[];
    }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on(CHANNELS.sessionTodo.changed, listener);
    return () => ipcRenderer.removeListener(CHANNELS.sessionTodo.changed, listener);
  },

  // agent_spawn — sub-agent lifecycle event stream
  onAgentSpawnEvent: (
    handler: (event: {
      spawnId: string;
      type: "start" | "activity" | "done" | "error";
      title?: string;
      entries?: ChatEntry[];
      summary?: string;
      toolCallCount?: number;
      message?: string;
      toolUseId?: string;
      // JOIN KEY for the unified resume transcript (mirrors `AgentSpawnEvent`).
      childSessionId?: string;
    }) => void,
  ) => {
    const listener = (_e: unknown, ev: Parameters<typeof handler>[0]) => handler(ev);
    ipcRenderer.on(CHANNELS.agentSpawn.event, listener);
    return () => ipcRenderer.removeListener(CHANNELS.agentSpawn.event, listener);
  },

  // skill_load — chat-side badge event
  onSkillLoaded: (
    handler: (event: {
      name: string;
      description: string;
    }) => void,
  ) => {
    const listener = (_e: unknown, ev: Parameters<typeof handler>[0]) => handler(ev);
    ipcRenderer.on(CHANNELS.skillLoad.event, listener);
    return () => ipcRenderer.removeListener(CHANNELS.skillLoad.event, listener);
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
    ipcRenderer.on(CHANNELS.notification.toast, listener);
    return () => ipcRenderer.removeListener(CHANNELS.notification.toast, listener);
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
    ipcRenderer.on(CHANNELS.notification.clicked, listener);
    return () => ipcRenderer.removeListener(CHANNELS.notification.clicked, listener);
  },
  notifyClick: async (payload: {
    kind: "turn-end" | "routine" | "ask-user" | "approval" | "plugin" | "system";
    contextRef?: {
      sessionId?: string;
      routineId?: string;
      questionId?: string;
      approvalId?: string;
    };
  }) => ipcRenderer.invoke(CHANNELS.notification.clicked, payload),

  // ─── Window management (tab detach + optional magnetic snap) ─────────────
  window: {
    /** Open viewKey in a new detached BrowserWindow. */
    openDetached: async (viewKey: string) =>
      ipcRenderer.invoke(CHANNELS.window.openDetached, viewKey) as Promise<
        { ok: true; windowId: number } | { ok: false; error: string }
      >,
    /** Close the current detached window (no-op in main window). */
    closeDetached: async () =>
      ipcRenderer.invoke(CHANNELS.window.closeDetached) as Promise<{ ok: true } | { ok: false; error: string }>,
    /** List all currently open detached windows. */
    listDetached: async () =>
      ipcRenderer.invoke(CHANNELS.window.listDetached) as Promise<
        Array<{ windowId: number; viewKey: string; snapped: boolean }>
      >,
    /**
     * Close ALL detached windows (fired on the work-mode transition so every
     * view re-renders inline). Auth/login windows are excluded by the main
     * process — they are never tracked as detached tabs.
     */
    closeAllDetached: async () =>
      ipcRenderer.invoke(CHANNELS.window.closeAllDetached) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    loadSessionInMain: async (sessionId: string) =>
      ipcRenderer.invoke(CHANNELS.window.loadSessionInMain, sessionId) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    /**
     * Resize the main window to match the current workspace mode.
     * "work" → centered work canvas on the primary work area;
     * "chat" → the right-docked initial bounds (computeInitialMainWindowBounds).
     */
    resizeForMode: async (mode: "chat" | "work") =>
      ipcRenderer.invoke(CHANNELS.window.resizeForMode, mode) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    /**
     * Resize the chat-mode main window for the right-side work panel. Opening
     * adds side-panel width; closing restores the normal chat bounds.
     */
    resizeForSidePanel: async (open: boolean) =>
      ipcRenderer.invoke(CHANNELS.window.resizeForSidePanel, open) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    /** Open a render_html result in an isolated BrowserWindow. */
    openHtmlPreview: async (payload: OpenHtmlPreviewWindowPayload) =>
      ipcRenderer.invoke(CHANNELS.window.openHtmlPreview, payload) as Promise<OpenHtmlPreviewWindowResult>,
    /**
     * Subscribe to snap-edge highlight events sent from the main process
     * when a child window enters/exits the snap zone.
     * edge: "n"|"s"|"e"|"w" when entering, null when leaving.
     */
    onSnapEdge: (handler: (edge: "n" | "s" | "e" | "w" | null) => void) => {
      const listener = (_event: unknown, edge: "n" | "s" | "e" | "w" | null) => handler(edge);
      ipcRenderer.on(CHANNELS.window.snapEdge, listener);
      return () => ipcRenderer.removeListener(CHANNELS.window.snapEdge, listener);
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
      ipcRenderer.on(CHANNELS.window.detachedNavigate, listener);
      return () => ipcRenderer.removeListener(CHANNELS.window.detachedNavigate, listener);
    },
    onLoadSessionInMain: (handler: (sessionId: string) => boolean | void | Promise<boolean | void>) => {
      const listener = (_event: unknown, payload: { sessionId?: unknown }) => {
        if (typeof payload?.sessionId !== "string") return;
        void Promise.resolve()
          .then(() => handler(payload.sessionId))
          .then((loaded) => {
            if (typeof (payload as { requestId?: unknown }).requestId !== "string") return;
            ipcRenderer.send(CHANNELS.window.loadSessionInMainResult, {
              requestId: (payload as { requestId: string }).requestId,
              ok: loaded !== false,
              ...(loaded === false ? { error: "load-session-failed" } : {}),
            });
          })
          .catch((err: unknown) => {
            if (typeof (payload as { requestId?: unknown }).requestId !== "string") return;
            ipcRenderer.send(CHANNELS.window.loadSessionInMainResult, {
              requestId: (payload as { requestId: string }).requestId,
              ok: false,
              error: err instanceof Error ? err.message : "load-session-failed",
            });
          });
      };
      ipcRenderer.on(CHANNELS.window.loadSessionInMain, listener);
      return () => ipcRenderer.removeListener(CHANNELS.window.loadSessionInMain, listener);
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
      ipcRenderer.invoke(CHANNELS.dev.setPreflightOverride, tokens) as Promise<
        { ok: true; value: number | null } | { ok: false; error: string }
      >,
    getPreflightStatus: async () =>
      ipcRenderer.invoke(CHANNELS.dev.getPreflightStatus) as Promise<
        | { ok: true; runtimeOverride: number | null; envOverride: number | null; effective: number; provider: string; model: string }
        | { ok: false; error: string }
      >,
  },
  };
}

export function buildLvisHostWorld() {
  let hostMarketplaceApiClaimed = false;
  return {
  takePluginMarketplaceApi: () => {
    if (hostMarketplaceApiClaimed) return null;
    hostMarketplaceApiClaimed = true;
    return {
      installMarketplacePlugin: async (
        pluginId: string,
        expectedVersion?: string,
        options?: { networkAccessAcknowledgement?: unknown },
      ) =>
        normalizePluginActionResult(await ipcRenderer.invoke(CHANNELS.plugins.install, pluginId, {
          ...(expectedVersion ? { expectedVersion } : {}),
          ...(options?.networkAccessAcknowledgement ? { networkAccessAcknowledgement: options.networkAccessAcknowledgement } : {}),
        })),
      uninstallMarketplacePlugin: async (pluginId: string) =>
        normalizePluginActionResult(await ipcRenderer.invoke(CHANNELS.plugins.uninstall, pluginId)),
      installMarketplaceAgent: async (slug: string) =>
        normalizeMarketplacePackageActionResult(await ipcRenderer.invoke(CHANNELS.agents.install, slug), "agentId"),
      uninstallMarketplaceAgent: async (slug: string) =>
        normalizeMarketplacePackageActionResult(await ipcRenderer.invoke(CHANNELS.agents.uninstall, slug), "agentId"),
      installMarketplaceSkill: async (slug: string) =>
        normalizeMarketplacePackageActionResult(await ipcRenderer.invoke(CHANNELS.skills.install, slug), "skillId"),
      uninstallMarketplaceSkill: async (slug: string) =>
        normalizeMarketplacePackageActionResult(await ipcRenderer.invoke(CHANNELS.skills.uninstall, slug), "skillId"),
    };
  },
  };
}

export function buildLvisPlatformWorld() {
  return {
    isDarwin: process.platform === "darwin",
  };
}

export function buildLvisWindowWorld() {
  return {
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
  };
}

export function buildLvisNamespaceExtras() {
  return {
  plugins: {
    cards: () => ipcRenderer.invoke(CHANNELS.plugins.cards),
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
    get: (pluginId: string) => ipcRenderer.invoke(CHANNELS.plugins.configGet, pluginId),
    set: (pluginId: string, config: Record<string, unknown>) => ipcRenderer.invoke(CHANNELS.plugins.configSet, pluginId, config),
    getSchema: (pluginId: string) => ipcRenderer.invoke(CHANNELS.plugins.configSchemaGet, pluginId),
    setSecret: (pluginId: string, key: string, value: string) =>
      ipcRenderer.invoke(CHANNELS.plugins.configSecretSet, pluginId, key, value),
    // US-3c.1: batch secret-presence query — returns keys for which the
    // keychain holds a value. Fewer IPC round-trips than per-key checks.
    listSecretKeys: (pluginId: string) =>
      ipcRenderer.invoke(CHANNELS.plugins.configSecretListKeys, pluginId),
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
    openFile: () => ipcRenderer.invoke(CHANNELS.attach.openFile),
    readImage: (filePath: string) =>
      ipcRenderer.invoke(CHANNELS.attach.readImage, filePath),
    saveClipboardImage: (base64: string) =>
      ipcRenderer.invoke(CHANNELS.attach.saveClipboardImage, { base64 }),
    openExternal: (filePath: string) =>
      ipcRenderer.invoke(CHANNELS.attach.openExternal, filePath),
  },
  preview: {
    readFile: (filePath: string) =>
      ipcRenderer.invoke(CHANNELS.preview.readFile, filePath),
  },
  workspace: {
    listRoots: () => ipcRenderer.invoke(CHANNELS.workspace.listRoots),
    pickRoot: (opts?: { ackToken?: string }) =>
      ipcRenderer.invoke(CHANNELS.workspace.pickRoot, opts),
    listDir: (dirPath: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.listDir, dirPath),
    removeRoot: (dirPath: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.removeRoot, dirPath),
    reveal: (targetPath: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.reveal, targetPath),
    // Drag-drop add-root, step 1 (#1458): submit a renderer-resolved dropped
    // folder path for Layer-0 + is-a-dir validation and a main-owned ack token.
    dropPrepare: (droppedPath: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.dropPrepare, droppedPath),
  },
  };
}
