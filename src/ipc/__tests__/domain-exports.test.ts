/**
 * IPC domain named-export lock — Commit C0 safety snapshot.
 *
 * Statically imports every module under `src/ipc/domains/*.ts` and snapshots
 * each module's sorted RUNTIME named-export list (`Object.keys(mod).sort()`).
 * The behavior-preserving refactor that follows moves these exports around;
 * dropping / renaming a runtime export changes this snapshot.
 *
 * Type-only exports (`SafeThemePayload`, `SerializedHistoryMessage`) are erased
 * at runtime and never appear in `Object.keys`; they are locked separately via
 * the compile-time `import type` aliases at the bottom of this file.
 *
 * MUST pass against the current (unchanged) code.
 */
import { describe, expect, it, vi } from "vitest";

// Importing every domain pulls the full transitive graph; each module does
// `import { ipcMain } from "electron"` at load, so electron must be mocked.
// No handler runs here — this is a plain import + Object.keys read.
vi.mock("electron", () => {
  const electron = {
    ipcMain: {
      handle: () => {},
      handleOnce: () => {},
      on: () => {},
      removeHandler: () => {},
      removeAllListeners: () => {},
      off: () => {},
      emit: () => {},
    },
    BrowserWindow: class BrowserWindow {
      static getAllWindows() {
        return [];
      }
      static fromWebContents() {
        return null;
      }
      static getFocusedWindow() {
        return null;
      }
    },
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

import * as attach from "../domains/attach.js";
import * as audit from "../domains/audit.js";
import * as chat from "../domains/chat.js";
import * as dev from "../domains/dev.js";
import * as misc from "../domains/misc.js";
import * as permissions from "../domains/permissions.js";
import * as plugins from "../domains/plugins.js";
import * as prompts from "../domains/prompts.js";
import * as settings from "../domains/settings.js";
import * as tour from "../domains/tour.js";
import * as ui from "../domains/ui.js";
import * as usage from "../domains/usage.js";
import * as window from "../domains/window.js";
import * as workBoard from "../domains/work-board.js";

const keys = (mod: Record<string, unknown>): string[] => Object.keys(mod).sort();

describe("IPC domain runtime named-export lock", () => {
  it("locks the sorted named-export list of every ipc domain", () => {
    const exportsByDomain = {
      attach: keys(attach),
      audit: keys(audit),
      chat: keys(chat),
      dev: keys(dev),
      misc: keys(misc),
      permissions: keys(permissions),
      plugins: keys(plugins),
      prompts: keys(prompts),
      settings: keys(settings),
      tour: keys(tour),
      ui: keys(ui),
      usage: keys(usage),
      window: keys(window),
      "work-board": keys(workBoard),
    };
    expect(exportsByDomain).toMatchInlineSnapshot(`
      {
        "attach": [
          "registerAttachHandlers",
        ],
        "audit": [
          "registerAuditHandlers",
        ],
        "chat": [
          "registerChatHandlers",
        ],
        "dev": [
          "registerDevHandlers",
        ],
        "misc": [
          "registerMiscHandlers",
        ],
        "permissions": [
          "broadcastPermissionConfigChanged",
          "registerPermissionsHandlers",
        ],
        "plugins": [
          "__resetLastThemePayloadForTests",
          "getLastThemePayload",
          "publishHostThemeChanged",
          "recordValidatedTheme",
          "registerPluginsHandlers",
          "replayThemeToWebview",
          "revokePluginWebviewsForPlugin",
          "unregisterPluginWebview",
          "validateThemePayload",
        ],
        "prompts": [
          "PROMPTS_UPDATED",
          "registerPromptHandlers",
        ],
        "settings": [
          "registerSettingsHandlers",
        ],
        "tour": [
          "TOUR_START_CHANNEL",
          "registerTourHandlers",
        ],
        "ui": [
          "registerUiHandlers",
        ],
        "usage": [
          "registerUsageHandlers",
        ],
        "window": [
          "registerWindowEventListeners",
          "registerWindowHandlers",
        ],
        "work-board": [
          "registerWorkBoardHandlers",
        ],
      }
    `);
  });
});

// ─── Compile-time locks for type-only exports ───────────────────────────────
// These do not appear in the runtime snapshot above (`import type` is erased).
// Referencing them via a type-level import means removing / renaming the export
// breaks `tsc` for any config that type-checks this file. NOTE: the repo's
// `tsconfig.json` excludes `src/**/__tests__/**`, so the default `tsc --noEmit`
// does not exercise these — they are a documentation-grade lock that becomes
// enforcing under a test-inclusive type-check.
type _SafeThemePayloadLock = import("../domains/plugins.js").SafeThemePayload;
type _SerializedHistoryMessageLock = import("../domains/chat.js").SerializedHistoryMessage;
// Structural touch so the aliases are unmistakably "used".
const _typeExportLocks: {
  safeTheme?: _SafeThemePayloadLock;
  serializedHistory?: _SerializedHistoryMessageLock;
} = {};
void _typeExportLocks;
