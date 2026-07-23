/**
 * #1409 IPC wire lock — Commit C0 safety snapshot.
 *
 * Records every channel `registerIpcHandlers` registers on `ipcMain`
 * (`handle` / `handleOnce` / `on`) and snapshots the SORTED, UNIQUE list.
 * This is the wire contract for the behavior-preserving IPC refactor that
 * follows: a renamed / removed / added channel MUST change this snapshot.
 *
 * MUST pass against the current (unchanged) code.
 *
 * Determinism: the dev-flags gate is forced to unpackaged (`setIsPackaged(false)`)
 * so the dev domain (`index.ts` gates it on `!getIsPackaged()`) and the mockup
 * every application IPC handler
 * are always registered — capturing the full wire independent of the host env.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `vi.hoisted` guarantees `channels` exists before the hoisted `vi.mock`
// factory runs, so the static `registerIpcHandlers` import can record into it.
const { channels } = vi.hoisted(() => ({ channels: [] as string[] }));

vi.mock("electron", () => {
  const record = (channel: unknown): void => {
    if (typeof channel === "string") channels.push(channel);
  };
  const ipcMain = {
    handle: (channel: string) => record(channel),
    handleOnce: (channel: string) => record(channel),
    on: (channel: string) => record(channel),
    removeHandler: () => {},
    removeAllListeners: () => {},
    off: () => {},
    emit: () => {},
  };
  class BrowserWindow {
    webContents = {
      send: () => {},
      on: () => {},
      setWindowOpenHandler: () => {},
      id: 1,
    };
    on() {}
    loadURL() {}
    show() {}
    close() {}
    setMenu() {}
    isDestroyed() {
      return false;
    }
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
    static getFocusedWindow() {
      return null;
    }
  }
  const electron = {
    ipcMain,
    BrowserWindow,
    app: {
      getPath: () => "/tmp/lvis-test",
      getAppPath: () => "/tmp/lvis-app",
      getName: () => "lvis",
      getVersion: () => "0.0.0-test",
      getLocale: () => "en-US",
      isPackaged: false,
      on: () => {},
      whenReady: () => Promise.resolve(),
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 }),
    },
    Menu: class Menu {
      append() {}
      popup() {}
      static buildFromTemplate() {
        return new Menu();
      }
      static setApplicationMenu() {}
    },
    MenuItem: class MenuItem {},
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }),
      createFromDataURL: () => ({ isEmpty: () => true }),
    },
    nativeTheme: { shouldUseDarkColors: false, on: () => {} },
    shell: { openExternal: async () => {}, openPath: async () => "" },
    webContents: { getAllWebContents: () => [], fromId: () => null },
    clipboard: { readText: () => "", writeText: () => {} },
    session: {
      fromPartition: () => ({ setPermissionRequestHandler: () => {} }),
      defaultSession: { setPermissionRequestHandler: () => {} },
    },
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { invoke: async () => {}, on: () => {}, send: () => {}, removeListener: () => {} },
  };
  return { ...electron, default: electron };
});

import { registerIpcHandlers } from "../index.js";
import { setIsPackaged, _resetForTest } from "../../boot/dev-flags.js";
import type { AppServices } from "../../boot/types.js";

// Every top-level service field of AppServices. The mock proxy enumerates
// these so `{ ...services }` inside registerIpcHandlers carries a live nested
// proxy for each — no registrar destructure resolves to `undefined`.
const SERVICE_KEYS: (string | symbol)[] = [
  "pythonRuntime",
  "pythonPath",
  "pluginRuntime",
  "pluginMarketplace",
  "settingsService",
  "memoryManager",
  "keywordEngine",
  "routeEngine",
  "toolRegistry",
  "systemPromptBuilder",
  "conversationLoop",
  "routineEngine",
  "mcpManager",
  "mcpArtifactStore",
  "agentArtifactStore",
  "skillArtifactStore",
  "idleScheduler",
  "preferenceRefreshService",
  "bashAstValidator",
  "auditService",
  "auditLogger",
  "postTurnHookChain",
  "approvalGate",
  "rewireReviewerAgent",
  "refreshMarketplaceFetcherConfig",
  "refreshActiveLlmWildcard",
  "refreshSandboxNetworkConfig",
  "knowledgeAvailable",
  "starredStore",
  "feedbackStore",
  "getSubAgentRunner",
  "routinesStore",
  "routinesScheduler",
  "sessionTodoStore",
  "workBoardStore",
  "workBoardEngine",
  "workBoardReport",
  "askUserQuestionGate",
  "skillStore",
  "agentProfileStore",
  "personaPromptStore",
  "refreshPluginNotifications",
  "pluginPaths",
  "clearAuthPartitionService",
  "listPluginAuthPartitionsService",
  "forgetPluginAuthPartitionsService",
  "registerPluginEventBridge",
  "telemetry",
  "pluginTelemetry",
  "autoUpdaterStop",
  "runPluginShutdownHandlers",
  "shutdown",
  "startRoutinesScheduler",
  "startWorkBoardDueSoon",
  "notificationService",
  "scriptHookManager",
];

import { makeDeepProxy } from "../../testing/deep-proxy.js";

beforeAll(() => {
  channels.length = 0;
  setIsPackaged(false);
  const services = makeDeepProxy(SERVICE_KEYS) as unknown as AppServices;
  registerIpcHandlers(services, () => null);
});

afterAll(() => {
  _resetForTest();
});

describe("IPC channel inventory (#1409 wire lock)", () => {
  it("registers a stable, sizeable set of channels", () => {
    const unique = [...new Set(channels)];
    // Sanity bound — a wholesale regression (registrars not wired) trips this
    // before the snapshot diff even matters.
    expect(unique.length).toBeGreaterThan(50);
  });

  it("locks the sorted unique channel list", () => {
    const sorted = [...new Set(channels)].sort();
    expect(sorted).toMatchInlineSnapshot(`
      [
        "lvis:a2a-remote:action",
        "lvis:a2a-remote:send",
        "lvis:a2a-remote:status",
        "lvis:a2a-remote:targets",
        "lvis:a2a-remote:task",
        "lvis:agents:install",
        "lvis:agents:list",
        "lvis:agents:uninstall",
        "lvis:app:info",
        "lvis:approval:respond",
        "lvis:ask-user-question:respond",
        "lvis:attach:openExternal",
        "lvis:attach:openFile",
        "lvis:attach:readImage",
        "lvis:attach:saveClipboardImage",
        "lvis:audit:search",
        "lvis:audit:stats",
        "lvis:bootstrap:retry",
        "lvis:chat:abort",
        "lvis:chat:branch-from-checkpoint",
        "lvis:chat:compact",
        "lvis:chat:continue-last-user",
        "lvis:chat:edit-resend",
        "lvis:chat:enter-checkpoint-view",
        "lvis:chat:exit-checkpoint-view",
        "lvis:chat:export",
        "lvis:chat:fork",
        "lvis:chat:get-history",
        "lvis:chat:get-sub-agent-transcript",
        "lvis:chat:get-verbatim-tool-result",
        "lvis:chat:get-write-diff",
        "lvis:chat:guide",
        "lvis:chat:has-provider",
        "lvis:chat:import",
        "lvis:chat:main-active-state",
        "lvis:chat:new",
        "lvis:chat:retry-effort",
        "lvis:chat:send",
        "lvis:chat:session-history",
        "lvis:chat:session-resume",
        "lvis:chat:sessions",
        "lvis:dev:getPreflightStatus",
        "lvis:dev:setPreflightOverride",
        "lvis:diagnostics:crash-list",
        "lvis:diagnostics:export",
        "lvis:dlp:stats",
        "lvis:feedback:submit",
        "lvis:host:plugin-theme-notify",
        "lvis:llm:ping",
        "lvis:logs:tail",
        "lvis:marketplace:ping",
        "lvis:mcp:call-tool",
        "lvis:mcp:catalog:list",
        "lvis:mcp:config:add",
        "lvis:mcp:config:get",
        "lvis:mcp:config:path",
        "lvis:mcp:config:remove",
        "lvis:mcp:config:set-api-key",
        "lvis:mcp:dispose-ui-session",
        "lvis:mcp:import:claude-desktop:apply",
        "lvis:mcp:import:claude-desktop:preview",
        "lvis:mcp:install-from-marketplace",
        "lvis:mcp:kill",
        "lvis:mcp:servers",
        "lvis:mcp:ui-download-file",
        "lvis:mcp:ui-message",
        "lvis:mcp:ui-model-context",
        "lvis:mcp:ui-resource",
        "lvis:memory:agents-md:get",
        "lvis:memory:agents-md:update",
        "lvis:memory:entries:delete",
        "lvis:memory:entries:list",
        "lvis:memory:entries:save",
        "lvis:memory:entries:search",
        "lvis:memory:index:get",
        "lvis:memory:index:sections:update",
        "lvis:memory:index:update-if-unchanged",
        "lvis:memory:sessions:list",
        "lvis:memory:sessions:search",
        "lvis:memory:user-prefs:get",
        "lvis:memory:user-prefs:refresh",
        "lvis:memory:user-prefs:update",
        "lvis:notification:clicked",
        "lvis:permission:add-rule",
        "lvis:permission:get-mode",
        "lvis:permission:list-rules",
        "lvis:permission:remove-rule",
        "lvis:permission:set-mode",
        "lvis:permissions:audit-show",
        "lvis:permissions:audit-verify",
        "lvis:permissions:deferred-list",
        "lvis:permissions:deferred-resolve",
        "lvis:permissions:dir-dispatch",
        "lvis:permissions:hook-trust-list",
        "lvis:permissions:reviewer-dispatch",
        "lvis:permissions:reviewer-provider-has-key",
        "lvis:permissions:sandbox-capability",
        "lvis:permissions:sandbox-windows-install",
        "lvis:permissions:sandbox-windows-status",
        "lvis:permissions:user-approval-list",
        "lvis:permissions:user-approval-record",
        "lvis:permissions:user-approval-revoke",
        "lvis:plugin:call-tool",
        "lvis:plugin:config:get",
        "lvis:plugin:config:set",
        "lvis:plugin:emit-event",
        "lvis:plugin:get-entry-url",
        "lvis:plugin:get-theme",
        "lvis:plugin:register-webview",
        "lvis:plugin:request-operation-grant",
        "lvis:plugin:storage:get",
        "lvis:plugin:storage:set",
        "lvis:plugins:call",
        "lvis:plugins:cards",
        "lvis:plugins:config:get",
        "lvis:plugins:config:schema:get",
        "lvis:plugins:config:secret:list-keys",
        "lvis:plugins:config:secret:set",
        "lvis:plugins:config:set",
        "lvis:plugins:contribution-trust:list",
        "lvis:plugins:contribution-trust:set",
        "lvis:plugins:install",
        "lvis:plugins:install-local",
        "lvis:plugins:marketplace:list",
        "lvis:plugins:perf-stats",
        "lvis:plugins:rollback",
        "lvis:plugins:set-enabled",
        "lvis:plugins:ui:list",
        "lvis:plugins:ui:read-module",
        "lvis:plugins:uninstall",
        "lvis:policy:get",
        "lvis:policy:set",
        "lvis:preview:read-file",
        "lvis:prompts:delete",
        "lvis:prompts:list",
        "lvis:prompts:list-summaries",
        "lvis:prompts:save",
        "lvis:routines:v2:ack-result",
        "lvis:routines:v2:add",
        "lvis:routines:v2:dismiss",
        "lvis:routines:v2:list",
        "lvis:routines:v2:list-sessions",
        "lvis:routines:v2:pending-results",
        "lvis:routines:v2:remove",
        "lvis:routines:v2:trigger-now",
        "lvis:runtime:counts",
        "lvis:runtime:env",
        "lvis:session-todo:clear",
        "lvis:session-todo:list",
        "lvis:settings:apply-host-map",
        "lvis:settings:delete-api-key",
        "lvis:settings:delete-web-api-key",
        "lvis:settings:get",
        "lvis:settings:has-api-key",
        "lvis:settings:has-web-api-key",
        "lvis:settings:list-llm-models",
        "lvis:settings:marketplace:delete-api-key",
        "lvis:settings:marketplace:has-api-key",
        "lvis:settings:marketplace:install-provider-preset",
        "lvis:settings:marketplace:set-api-key",
        "lvis:settings:marketplace:uninstall-provider-preset",
        "lvis:settings:set-api-key",
        "lvis:settings:set-web-api-key",
        "lvis:settings:update",
        "lvis:shell:open-external",
        "lvis:sidechat:abort",
        "lvis:sidechat:list",
        "lvis:sidechat:load",
        "lvis:sidechat:new",
        "lvis:sidechat:send",
        "lvis:skills:install",
        "lvis:skills:list",
        "lvis:skills:uninstall",
        "lvis:starred:add",
        "lvis:starred:list",
        "lvis:starred:remove",
        "lvis:telemetry:consent-answer",
        "lvis:terminal:input",
        "lvis:terminal:kill",
        "lvis:terminal:resize",
        "lvis:terminal:spawn",
        "lvis:tour:dismiss",
        "lvis:tour:get-state",
        "lvis:tour:mark-complete",
        "lvis:tour:start",
        "lvis:ui:assistant-context-menu",
        "lvis:ui:native-context-menu",
        "lvis:usage:daily-summary",
        "lvis:usage:export-csv",
        "lvis:usage:range",
        "lvis:usage:summary",
        "lvis:window:open-html-preview",
        "lvis:work-board:add",
        "lvis:work-board:complete",
        "lvis:work-board:generate-report",
        "lvis:work-board:get",
        "lvis:work-board:list",
        "lvis:work-board:remove",
        "lvis:work-board:reopen",
        "lvis:work-board:run",
        "lvis:work-board:run-transcript",
        "lvis:work-board:transition",
        "lvis:work-board:update",
        "lvis:workspace:drop-prepare",
        "lvis:workspace:list-dir",
        "lvis:workspace:list-roots",
        "lvis:workspace:pick-root",
        "lvis:workspace:remove-root",
        "lvis:workspace:reveal",
        "window:close",
        "window:minimize",
        "window:syncTitleBarTheme",
        "window:toggleMaximize",
      ]
    `);
  });
});
