/**
 * ONE permission-config broadcast, reaching every live loop.
 *
 * `PERMISSIONS.configChanged` had five wirings: the canonical
 * `ipc/domains/permissions.ts:broadcastPermissionConfigChanged` plus four boot
 * stubs that each hand-built a deps stand-in and cast it into place. Two facts
 * that consolidation has to pin:
 *
 *  1. The host-side broadcast fans out over the CURATED app-window set
 *     (`main/main-window.ts:getAppWindows`), never `BrowserWindow.getAllWindows()`.
 *     The raw list reaches top-level windows deliberately kept out of host
 *     broadcasts — the OAuth window, the external-link window, the auth-partition
 *     viewer — and `sendToWindow` does no origin check.
 *  2. EVERY loop built by the real factories reports permission mutations. Only
 *     the main chat loop used to receive the callback, so `/permission hooks
 *     accept` in the side chat, or a session-directory grant in a routine turn,
 *     mutated the same global permission state with no window ever told.
 */
import { describe, expect, it, vi } from "vitest";
import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ToolRegistry } from "../../tools/registry.js";
import {
  makeConversationLoopMemoryManager,
  makeConversationLoopSettings,
} from "../../engine/__tests__/conversation-loop-test-helpers.js";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import { liveWindow } from "../../__tests__/test-helpers.js";

const h = vi.hoisted(() => ({
  curatedWindows: [] as unknown[],
  mainWindow: null as unknown,
  getAllWindows: vi.fn(() => [] as unknown[]),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: h.getAllWindows },
  shell: { openExternal: vi.fn(async () => {}) },
}));

vi.mock("../../main/main-window.js", () => ({
  getAppWindows: () => h.curatedWindows,
}));

vi.mock("../../main/app-state.js", () => ({
  getMainWindow: () => h.mainWindow,
}));

import { broadcastPermissionConfigChangedFromHost } from "../permission-config-broadcast.js";
import {
  createConversationLoop,
  createRoutineConversationLoop,
  createSideChatConversationLoop,
  type ConversationDeps,
  type RoutineConversationLoopDeps,
  type SideChatConversationLoopDeps,
} from "../conversation.js";

/**
 * The deps bags below are cast (the factories want full service objects), so
 * the cast could hide the very key under test being renamed or dropped from a
 * factory's dep type. Type the spy through all three real dep types instead:
 * remove `broadcastPermissionConfigChanged` from any of those Picks and this
 * line stops compiling under `check:typecheck-tests`.
 */
type LoopBroadcastCallback =
  & NonNullable<ConversationDeps["broadcastPermissionConfigChanged"]>
  & NonNullable<RoutineConversationLoopDeps["broadcastPermissionConfigChanged"]>
  & NonNullable<SideChatConversationLoopDeps["broadcastPermissionConfigChanged"]>;

function sharedLoopDeps() {
  return {
    settingsService: makeConversationLoopSettings(),
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry: new ToolRegistry(),
    memoryManager: makeConversationLoopMemoryManager(),
    memoryReviewer: { review: async () => "recap" },
    pluginRuntime: { listPluginCards: () => [], listPluginIds: () => [], listAll: () => [] },
    permissionManager: {},
    approvalGate: {},
    hookRunner: {},
    bashAstValidator: {},
    pluginOperationGrants: {},
    pluginOperationIdentityProvider: {},
    systemPromptBuilder: {
      build: () => "system",
      setToolScope: vi.fn(),
      setOriginSource: vi.fn(),
      setActiveSessionId: vi.fn(),
      setActiveRolePrompt: vi.fn(),
      setProjectContext: vi.fn(),
      setRoutineMode: vi.fn(),
    },
  };
}

describe("host permission-config broadcast — window set", () => {
  it("fans out over the curated app windows and never the raw window list", () => {
    const curated = liveWindow();
    const oauthWindow = liveWindow();
    h.curatedWindows = [curated];
    h.mainWindow = curated;
    h.getAllWindows.mockReturnValue([curated, oauthWindow]);

    broadcastPermissionConfigChangedFromHost();

    expect(curated.webContents.send).toHaveBeenCalledWith(PERMISSIONS.configChanged, {});
    // The OAuth / external-link / partition-viewer class of top-level window is
    // NOT in the curated set and must not receive host permission events.
    expect(oauthWindow.webContents.send).not.toHaveBeenCalled();
    expect(h.getAllWindows).not.toHaveBeenCalled();
  });
});

describe("permission-config broadcast — every real loop factory reports", () => {
  it.each([
    ["main chat", (deps: Record<string, unknown>) => createConversationLoop(deps as never)],
    ["side chat", (deps: Record<string, unknown>) => createSideChatConversationLoop({
      ...deps,
      sideChatMemoryManager: makeConversationLoopMemoryManager(),
    } as never)],
    ["routine", (deps: Record<string, unknown>) => createRoutineConversationLoop(deps as never, {})],
  ])("%s loop broadcasts a session-directory grant", (_name, build) => {
    const broadcastPermissionConfigChanged: LoopBroadcastCallback = vi.fn();
    const loop = build({ ...sharedLoopDeps(), broadcastPermissionConfigChanged });

    loop.addSessionAdditionalDirectory("/tmp/granted-scope");

    expect(broadcastPermissionConfigChanged).toHaveBeenCalledTimes(1);
  });
});
