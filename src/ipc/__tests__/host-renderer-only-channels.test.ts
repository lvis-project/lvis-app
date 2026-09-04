/**
 * The plugin UI shell is a `file://` frame, so the base sender validator admits
 * it. That validator is the protocol allow-list, not a trust decision: the only
 * IPC a plugin is meant to reach is the `pluginBridge.*` bridge, which has its
 * own validator. Every other host channel therefore takes
 * `validateHostRendererSender`, which rejects the shell.
 *
 * The narrow `window.lvisPlugin` preload is not what enforces this — it only
 * shapes what plugin authors can call. A compromised plugin renderer holds
 * `ipcRenderer` itself and can invoke any channel name, so the main-side frame
 * check is the only thing that holds.
 *
 * Each channel in the table is driven from BOTH frames, and what the table
 * asserts is the guard's reject branch: an `ipc-guard` audit row appears for
 * the plugin shell and does not appear for the host renderer. Driving only the
 * plugin direction would stay green if a channel started refusing everyone.
 *
 * The audit row is the table's observable because the rejection sentinels
 * differ per handler (some return `UNAUTHORIZED_FRAME`, some a domain-shaped
 * empty result, some nothing at all) while `auditUnauthorized` is one shared
 * call site. It is a proxy, and worth naming as one: it shows the guard took
 * its reject branch, not that the handler returned nothing afterwards. A
 * handler that audited and then answered anyway would keep the table green.
 *
 * `lvis:app:info` is additionally asserted by return value at the bottom of
 * this file, where "refused" means the caller got `UNAUTHORIZED_FRAME` and none
 * of the host fields.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { hostFrameEvent, pluginShellFrameEvent } from "../../__tests__/test-helpers.js";

const { CHANNELS } = await import("../../contract/app-contract.js");
const { ROUTINES, WORK_BOARD } = await import("../../shared/ipc-channels.js");
const { setIsPackaged } = await import("../../boot/dev-flags.js");
const { UNAUTHORIZED_FRAME } = await import("../gated.js");

const handleMap = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("electron", () => {
  const noopWindow = {
    id: 1,
    isDestroyed: () => false,
    webContents: { send: vi.fn(), id: 1, isDestroyed: () => false, session: { setSpellCheckerEnabled: vi.fn() } },
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isMaximized: () => false,
    close: vi.fn(),
    setTitleBarOverlay: vi.fn(),
  };
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        handleMap.set(channel, fn);
      }),
      on: vi.fn(),
      removeHandler: vi.fn(),
    },
    BrowserWindow: Object.assign(vi.fn(() => noopWindow), {
      getAllWindows: () => [],
      fromWebContents: () => null,
      getFocusedWindow: () => null,
    }),
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      showSaveDialog: vi.fn(async () => ({ canceled: true })),
      showMessageBox: vi.fn(async () => ({ response: 1 })),
    },
    shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
    app: { getPath: vi.fn(() => "/nonexistent-app-path"), getVersion: vi.fn(() => "0.0.0-test"), getName: vi.fn(() => "lvis") },
    nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
    clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
    webContents: { fromId: vi.fn(() => null), getAllWebContents: () => [] },
    session: { fromPartition: vi.fn(() => ({ webRequest: { onBeforeRequest: vi.fn() }, protocol: { handle: vi.fn() } })) },
    net: { fetch: vi.fn() },
  };
});

type AuditRow = { sessionId?: string; input?: string };
const auditRows: AuditRow[] = [];
const auditLogger = {
  log: vi.fn((row: AuditRow) => {
    auditRows.push(row);
  }),
  logWarn: vi.fn(),
  search: vi.fn(() => []),
  getStats: vi.fn(() => ({})),
  flush: vi.fn(async () => undefined),
  getAuditDir: vi.fn(() => "/nonexistent-audit-dir"),
  getPermissionAuditSecret: vi.fn(() => null),
};

/**
 * Enough shape for each `register*Handlers` to finish wiring. Handlers are
 * never driven past their guard here, so the bodies behind these stubs do not
 * have to be faithful — only present enough that registration completes.
 */
function makeDeps(): never {
  return {
    auditLogger,
    getMainWindow: () => null,
    conversationLoop: {
      getSessionId: () => "test-session",
      permissionManager: undefined,
      abortCurrentTurn: vi.fn(),
      generateText: vi.fn(async () => ""),
      getActiveStreamTurn: () => null,
    },
    sideChatConversationLoop: undefined,
    approvalGate: undefined,
    settingsService: {
      get: vi.fn(() => undefined),
      getAll: vi.fn(() => ({})),
      set: vi.fn(),
      patch: vi.fn(async () => undefined),
      getSecret: vi.fn(() => null),
      setSecret: vi.fn(async () => undefined),
      deleteSecret: vi.fn(async () => undefined),
      onChange: vi.fn(),
    },
    pluginRuntime: {
      getPluginManifest: vi.fn(() => null),
      getPluginRoot: vi.fn(() => null),
      getGenerationAccess: vi.fn(() => null),
      isPluginUiRevisionCurrent: vi.fn(() => false),
      resolveToolOwner: vi.fn(() => null),
      listPlugins: vi.fn(() => []),
    },
    revokePluginOperationSession: vi.fn(),
    workBoardStore: undefined,
  } as unknown as never;
}

/**
 * The sender guard's audit row is the one carrying `frameUrl`. Other
 * `ipc-guard` rows exist (payload-validation rejections inside a handler that
 * already passed its guard), and matching those would report a guard rejection
 * that never happened.
 */
function guardRowsFor(channel: string): AuditRow[] {
  return auditRows.filter((row) => {
    if (row.sessionId !== "ipc-guard" || typeof row.input !== "string") return false;
    const parsed = JSON.parse(row.input) as { channel?: string; frameUrl?: string };
    return parsed.channel === channel && typeof parsed.frameUrl === "string";
  });
}

/** What {@link invoke} returns when the handler threw. */
const THREW = Symbol("handler threw");

async function invoke(channel: string, event: IpcMainInvokeEvent, args: unknown[]): Promise<unknown> {
  const handler = handleMap.get(channel);
  expect(handler, `${channel} was never registered`).toBeDefined();
  try {
    return await handler!(event, ...args);
  } catch {
    // A throw means the handler ran past its guard into a stubbed dependency,
    // which is exactly what the host-renderer direction is asserting. Returned
    // as `THREW` rather than `undefined` so a value assertion cannot mistake a
    // crash for a handler that legitimately answered with nothing.
    return THREW;
  }
}

/** `[domain, channel, args]` — args are only what a handler needs to reach its guard. */
const HOST_ONLY_CHANNELS: ReadonlyArray<readonly [string, string, unknown[]]> = [
  // Full chat authority: sending turns, reading transcripts, editing memory.
  ["chat", CHANNELS.chat.send, [{ input: "x" }]],
  ["chat", CHANNELS.chat.sessions, []],
  ["chat", CHANNELS.chat.mainActiveState, []],
  ["chat", CHANNELS.chat.sessionHistory, ["s"]],
  ["chat", CHANNELS.memory.entriesList, [{}]],
  // Secret writes and the external-link opener.
  ["settings", CHANNELS.settings.update, [{}]],
  ["settings", CHANNELS.settings.setApiKey, ["anthropic", "k"]],
  ["settings", CHANNELS.shell.openExternal, ["https://example.com/"]],
  // Plugin management — the host settings screen, not the plugin bridge.
  ["plugins", CHANNELS.plugins.install, [{}]],
  ["plugins", CHANNELS.plugins.uninstall, ["p"]],
  ["plugins", CHANNELS.plugins.configSecretSet, ["p", "k", "v"]],
  ["plugins", CHANNELS.runtime.counts, []],
  ["plugins", CHANNELS.mcp.servers, []],
  // The host renderer registers plugin webviews on the shell's behalf, so this
  // one lives on the bridge channel prefix but is host-only: a shell that could
  // call it would be minting its own plugin binding.
  ["plugins", CHANNELS.pluginBridge.registerWebview, [{ webContentsId: 1, pluginId: "p", entryUrl: "file:///x" }]],
  ["plugins", CHANNELS.host.pluginThemeNotify, [{}]],
  // Side chat runs arbitrary tools on a second loop.
  ["sidechat", CHANNELS.sidechat.send, [{ input: "x" }]],
  // Routines and the session tasks list.
  ["routines", ROUTINES.list, []],
  ["session-tasks", CHANNELS.sessionTasks.list, []],
  ["session-goal", CHANNELS.sessionGoal.get, []],
  ["session-goal", CHANNELS.sessionGoal.pause, []],
  // Host identity + runtime versions. Read-only, but the response carries
  // `userDataPath` and is returned unprojected.
  ["app", CHANNELS.app.info, []],
  // Work board items drive agent runs.
  ["work-board", WORK_BOARD.list, [{}]],
  ["work-board", WORK_BOARD.run, [{}]],
  // Saved prompts are user-authored content.
  ["prompts", CHANNELS.prompts.list, []],
  ["prompts", CHANNELS.prompts.save, [{}]],
  // Onboarding state.
  ["tour", CHANNELS.tour.getState, []],
  ["tour", CHANNELS.tour.start, ["scenario"]],
  // Filesystem reach: workspace roots, attachment picking, file preview.
  ["workspace", CHANNELS.workspace.listRoots, []],
  ["workspace", CHANNELS.workspace.listDir, [{ path: "/" }]],
  ["attach", CHANNELS.attach.openFile, [{}]],
  ["attach", CHANNELS.attach.readImage, ["/x"]],
  ["preview", CHANNELS.preview.readFile, ["/x"]],
  // Usage and cost history.
  ["usage", CHANNELS.usage.range, [{}]],
  // The preflight override is a developer switch over host behaviour.
  ["dev", CHANNELS.dev.getPreflightStatus, []],
  // Window controls act on the host BrowserWindow the shell is embedded in.
  ["window", CHANNELS.window.minimize, []],
  ["window", CHANNELS.window.openHtmlPreview, [{ html: "<p>x</p>" }]],
];

beforeEach(async () => {
  handleMap.clear();
  auditRows.length = 0;
  vi.clearAllMocks();
  // The dev domain refuses everything when packaged, which would hide its
  // sender guard behind an earlier return.
  setIsPackaged(false);
  const deps = makeDeps();
  const [
    { registerChatHandlers },
    { registerSettingsHandlers },
    { registerPluginsHandlers },
    { registerSideChatHandlers },
    { registerRoutineHandlers },
    { registerSessionTasksHandlers },
    { registerSessionGoalHandlers },
    { registerAppHandlers },
    { registerWorkBoardHandlers },
    { registerPromptHandlers },
    { registerTourHandlers },
    { registerWorkspaceHandlers },
    { registerAttachHandlers },
    { registerPreviewHandlers },
    { registerUsageHandlers },
    { registerDevHandlers },
    { registerWindowHandlers },
  ] = await Promise.all([
    import("../domains/chat.js"),
    import("../domains/settings.js"),
    import("../domains/plugins.js"),
    import("../domains/sidechat.js"),
    import("../domains/routines.js"),
    import("../domains/session-tasks.js"),
    import("../domains/session-goal.js"),
    import("../domains/app.js"),
    import("../domains/work-board.js"),
    import("../domains/prompts.js"),
    import("../domains/tour.js"),
    import("../domains/workspace.js"),
    import("../domains/attach.js"),
    import("../domains/preview.js"),
    import("../domains/usage.js"),
    import("../domains/dev.js"),
    import("../domains/window.js"),
  ]);
  registerChatHandlers(deps);
  registerSettingsHandlers(deps);
  registerPluginsHandlers(deps);
  registerSideChatHandlers(deps);
  registerRoutineHandlers(deps);
  registerSessionTasksHandlers(deps);
  registerSessionGoalHandlers(deps);
  registerAppHandlers(deps);
  registerWorkBoardHandlers(deps);
  registerPromptHandlers(deps);
  registerTourHandlers(deps);
  registerWorkspaceHandlers(deps);
  registerAttachHandlers(deps);
  registerPreviewHandlers(deps);
  registerUsageHandlers(deps);
  registerDevHandlers(deps);
  registerWindowHandlers(deps);
});

describe("host-renderer-only IPC channels", () => {
  it.each(HOST_ONLY_CHANNELS)("%s %s refuses a plugin shell frame", async (_domain, channel, args) => {
    await invoke(channel, pluginShellFrameEvent(), args);
    expect(guardRowsFor(channel).length).toBeGreaterThan(0);
  });

  it.each(HOST_ONLY_CHANNELS)("%s %s does not refuse the host renderer", async (_domain, channel, args) => {
    await invoke(channel, hostFrameEvent(), args);
    expect(guardRowsFor(channel)).toEqual([]);
  });
});

/**
 * The table above cannot assert refusal by value — the sentinels are not
 * uniform. This channel's are: `UNAUTHORIZED_FRAME` on the reject branch, a
 * plain object of host fields on the pass branch, neither of which needs a
 * stub to produce. So the one channel whose module docstring claims a refusal
 * is the one channel where the refusal itself is pinned.
 */
describe("lvis:app:info — refusal by returned value, not only by audit row", () => {
  it("answers a plugin shell frame with UNAUTHORIZED_FRAME and no host fields", async () => {
    const result = await invoke(CHANNELS.app.info, pluginShellFrameEvent(), []);
    expect(result).toEqual(UNAUTHORIZED_FRAME);
    expect(Object.keys(result as Record<string, unknown>)).toEqual(["ok", "error"]);
  });

  it("answers the host renderer with the host fields", async () => {
    const result = (await invoke(CHANNELS.app.info, hostFrameEvent(), [])) as Record<string, unknown>;
    expect(result).toMatchObject({ platform: process.platform, arch: process.arch });
    expect(typeof result.version).toBe("string");
    expect(typeof result.userDataPath).toBe("string");
  });
});
