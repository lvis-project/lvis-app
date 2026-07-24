/**
 * #1409 C2 — contract version + public-surface freeze.
 *
 * Cross-checks the `src/contract/` public wire contract against the REAL
 * registered channel inventory (built with the same `registerIpcHandlers`
 * harness the C0 channel-inventory snapshot uses), so a public channel can
 * never be a typo and a gesture-gated mutating channel can never leak into the
 * externally-exposable subset.
 *
 * Asserts:
 *   1. CONTRACT_VERSION is a string.
 *   2. every PUBLIC_CHANNELS member is present in the channel inventory.
 *   3. every CHANNEL_GESTURE:"required" channel is present in the inventory
 *      (so the classification tracks real channels) AND is NOT in
 *      PUBLIC_CHANNELS (fail-closed: gesture-gated mutations never exposed).
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
    ipcRenderer: { invoke: async () => {}, on: () => {}, send: () => {}, removeListener: () => {},
    },
  };
  return { ...electron, default: electron };
});

import { registerIpcHandlers } from "../../ipc/index.js";
import { setIsPackaged, _resetForTest } from "../../boot/dev-flags.js";
import type { AppServices } from "../../boot/types.js";
import {
  CONTRACT_VERSION,
  PUBLIC_CHANNELS,
  CHANNEL_GESTURE,
  CHANNELS,
  EXTERNAL_MUTATION_CHANNELS,
} from "../app-contract.js";
import { TOUR_START_CHANNEL } from "../../ipc/domains/tour.js";
import { PROMPTS_UPDATED } from "../../ipc/domains/prompts.js";

// Mirrors channel-inventory.test.ts — enumerated so `{ ...services }` carries a
// live nested proxy for each field (no registrar destructure resolves undefined).
const SERVICE_KEYS: (string | symbol)[] = [
  "pythonRuntime",
  "pythonPath",
  "pluginRuntime",
  "pluginMarketplace",
  "settingsService",
  "memoryManager",
  "inputClassifier",
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

const inventory = new Set<string>();

beforeAll(() => {
  channels.length = 0;
  setIsPackaged(false);
  const services = makeDeepProxy(SERVICE_KEYS) as unknown as AppServices;
  registerIpcHandlers(services, () => null);
  for (const c of channels) inventory.add(c);
});

afterAll(() => {
  _resetForTest();
});

describe("#1409 contract version + public-surface freeze", () => {
  it("registers a sizeable inventory (harness sanity)", () => {
    expect(inventory.size).toBeGreaterThan(50);
  });

  it("CONTRACT_VERSION is a string", () => {
    expect(typeof CONTRACT_VERSION).toBe("string");
    expect(CONTRACT_VERSION.length).toBeGreaterThan(0);
  });

  it("every PUBLIC_CHANNELS member is a real registered channel", () => {
    for (const channel of PUBLIC_CHANNELS) {
      expect(inventory.has(channel), `PUBLIC channel not registered: ${channel}`,
      ).toBe(true);
    }
  });

  it("gesture:required channels are real, and never exposed publicly", () => {
    const publicSet = new Set<string>(PUBLIC_CHANNELS);
    const required = Object.entries(CHANNEL_GESTURE)
      .filter(([, gesture]) => gesture === "required")
      .map(([channel]) => channel);

    // Sanity: the classification must actually contain gesture-gated channels.
    expect(required.length).toBeGreaterThan(0);

    for (const channel of required) {
      expect(
        inventory.has(channel),
        `gesture:required channel not registered: ${channel}`,
      ).toBe(true);
      expect(
        publicSet.has(channel),
        `gesture:required channel leaked into PUBLIC_CHANNELS: ${channel}`,
      ).toBe(false);
    }
  });

  it("every EXTERNAL_MUTATION_CHANNELS member is gesture:required, non-public, and registered", () => {
    const publicSet = new Set<string>(PUBLIC_CHANNELS);

    // Sanity: the allowlist must actually contain entries (currently exactly one).
    expect(EXTERNAL_MUTATION_CHANNELS.length).toBeGreaterThan(0);

    for (const channel of EXTERNAL_MUTATION_CHANNELS) {
      // (a) gesture-gated — reachable externally ONLY via in-app ApprovalGate consent.
      expect(
        CHANNEL_GESTURE[channel],
        `EXTERNAL_MUTATION channel is not gesture:required: ${channel}`,
      ).toBe("required");
      // (b) never in the externally-exposable public subset (fail-closed).
      expect(
        publicSet.has(channel),
        `EXTERNAL_MUTATION channel leaked into PUBLIC_CHANNELS: ${channel}`,
      ).toBe(false);
      // (c) a real registered channel (reuses the registered-inventory harness).
      expect(
        inventory.has(channel),
        `EXTERNAL_MUTATION channel not registered: ${channel}`,
      ).toBe(true);
    }
  });
});

// M1 — binding assertion. The remaining in-tree IPC domains previously
// Domain channel constants source from CHANNELS; bind the tour and prompt
// constants here so a future rename fails in a deterministic unit test.
describe("#1409 M1 — domain channel consts bind to their CHANNELS twins", () => {
  it("TOUR_START_CHANNEL === CHANNELS.tour.start", () => {
    expect(TOUR_START_CHANNEL).toBe(CHANNELS.tour.start);
  });
  it("PROMPTS_UPDATED === CHANNELS.prompts.updated", () => {
    expect(PROMPTS_UPDATED).toBe(CHANNELS.prompts.updated);
  });
});
