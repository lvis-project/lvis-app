/**
 * renderApp helper.
 *
 * Stubs window.lvisApi / window.lvis with the provided overrides, renders
 * <App /> via @testing-library/react, returns the mock fns so tests can
 * assert IPC calls.
 */
// Registers RTL's `afterEach(cleanup)` (plus the jsdom polyfills) for EVERY
// consumer of this harness. Rendering the whole App and never unmounting it
// leaves its effects — including real timers — running past the end of the test
// file, and they then fire into a destroyed jsdom. Importing it here rather than
// asking each suite to remember means a new suite cannot forget.
import "./setup.js";
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import {
  makeMockLvisApi,
  makeMockLvisNamespace,
  type MockLvisApi,
} from "./mock-lvis-api.js";

type RenderAppOpts = Parameters<typeof makeMockLvisApi>[0] & {
  lvisEnv?: Partial<{
    isDev: boolean;
    isE2E: boolean;
    enableDevConsole: boolean;
    debugStream: boolean;
  }>;
  /** Approval requests the host is already parked on when the window mounts. */
  pendingApprovals?: unknown[];
};

export type RenderAppReturn = {
  container: RenderResult["container"];
  rerender: RenderResult["rerender"];
  unmount: RenderResult["unmount"];
  api: MockLvisApi;
  /** Which groups' loops were released — see `makeMockLvisApi`. */
  releasedGroupIds: () => string[];
  emitChatStream: (ev: unknown) => void;
  emitAgentSpawnEvent: ReturnType<typeof makeMockLvisApi>["emitAgentSpawnEvent"];
  emitSkillLoaded: ReturnType<typeof makeMockLvisApi>["emitSkillLoaded"];
  emitSessionTasksChanged: ReturnType<typeof makeMockLvisApi>["emitSessionTasksChanged"];
  emitOverlayShow: (item: unknown) => void;
  emitOverlayDismiss: (id: string) => void;
  emitRoutineFired: (r: unknown) => void;
  emitRoutineRunningStarted: (p: unknown) => void;
  emitPluginEvent: (eventType: string, payload: unknown) => void;
  emitViewActivate: (v: string, settingsTab?: string) => void;
  emitAskUserQuestion: (r: unknown) => void;
  emitApproval: (r: unknown) => void;
  /** The host retired a parked request — see `lvis:approval:settled`. */
  emitApprovalSettled: (requestId: string) => void;
  emitPluginRuntimeUpdated: (payload: { pluginId: string }) => void;
  emitNotificationToast: (payload: unknown) => void;
  emitNotificationClicked: (payload: unknown) => void;
};

/**
 * Seed the app mode the shell reads before first paint ("work" is the harness
 * default), and return the undo. Lives here rather than in each suite because
 * two suites spelling the same seed is exactly what the duplicate-helper gate
 * refuses — and a second spelling could drift from the preload key.
 */
export function startInChatMode(): () => void {
  (window as { __lvisInitialAppMode?: string }).__lvisInitialAppMode = "chat";
  return () => {
    delete (window as { __lvisInitialAppMode?: string }).__lvisInitialAppMode;
  };
}

export async function renderApp(opts: RenderAppOpts = {}): Promise<RenderAppReturn> {
  const { lvisEnv, pendingApprovals, ...apiOpts } = opts;
  const {
    api,
    releasedGroupIds,
    emitChatStream,
    emitAgentSpawnEvent,
    emitSkillLoaded,
    emitSessionTasksChanged,
    emitOverlayShow,
    emitOverlayDismiss,
    emitRoutineFired,
    emitRoutineRunningStarted,
    emitPluginEvent,
    emitViewActivate,
    emitAskUserQuestion,
    emitPluginRuntimeUpdated,
    emitNotificationToast,
    emitNotificationClicked,
  } = makeMockLvisApi(apiOpts);
  const { ns, emitApproval, emitApprovalSettled } = makeMockLvisNamespace({ env: lvisEnv, pendingApprovals });

  vi.stubGlobal("lvisApi", api);
  vi.stubGlobal("lvis", ns);
  (window as unknown as { lvisApi: MockLvisApi }).lvisApi = api;
  (window as unknown as { lvis: unknown }).lvis = ns;

  const { App } = await import("../../src/renderer.js");
  const result = render(<App />);

  return {
    container: result.container,
    rerender: result.rerender,
    unmount: result.unmount,
    api,
    releasedGroupIds,
    emitChatStream,
    emitAgentSpawnEvent,
    emitSkillLoaded,
    emitSessionTasksChanged,
    emitOverlayShow,
    emitOverlayDismiss,
    emitRoutineFired,
    emitRoutineRunningStarted,
    emitPluginEvent,
    emitViewActivate,
    emitAskUserQuestion,
    emitApproval,
    emitApprovalSettled,
    emitPluginRuntimeUpdated,
    emitNotificationToast,
    emitNotificationClicked,
  };
}

/**
 * Whether the app is showing the conversation rather than a view.
 *
 * The conversations stay MOUNTED across view navigation — a tile subscribes to
 * its group's stream when it mounts, so unmounting them to show another view
 * would drop the frames of a turn still running. "At home" is therefore whether
 * the surface is SHOWING, not whether it exists.
 *
 * It lives here rather than in each suite because check-test-duplicates rejects
 * the same helper body in two test files.
 */
export function atHome(container: HTMLElement): boolean {
  return container
    .querySelector('[data-testid="chat-surface"]')
    ?.getAttribute("data-visible") === "true";
}
