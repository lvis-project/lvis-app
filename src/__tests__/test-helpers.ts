import { vi } from "vitest";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { IpcMainInvokeEvent } from "electron";
import type { FeatureNamespaceHandle } from "../main/storage/feature-namespace.js";

export function makeMockWebContents() {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

/** The document the host renderer loads — `main-window.ts` loadFile(index.html). */
export const HOST_FRAME_URL = "file:///Applications/Lvis.app/dist/index.html";

/** The one document a plugin UI shell frame loads. */
export const PLUGIN_SHELL_FRAME_URL =
  "file:///Applications/Lvis.app/dist/plugin-ui-shell.html";

/**
 * A synthetic `IpcMainInvokeEvent` from the TRUSTED host renderer frame — the one
 * `validateHostRendererSender` accepts. THE shared builder: `validateSender` fails
 * closed on a missing frame, so a handler test can no longer hand its handler a
 * frameless `null`/`{}` and be treated as trusted. Every gated-IPC suite builds its
 * event here, so a newly written handler test gets a valid frame by default rather
 * than by remembering.
 */
export function hostFrameEvent(): IpcMainInvokeEvent {
  return {
    senderFrame: { url: HOST_FRAME_URL },
    sender: {},
  } as unknown as IpcMainInvokeEvent;
}

/** A synthetic event from ANY OTHER frame — a plugin shell, a remote page, an empty URL. */
export function foreignFrameEvent(url: string): IpcMainInvokeEvent {
  return { senderFrame: { url }, sender: {} } as unknown as IpcMainInvokeEvent;
}

/** A plugin-UI-shell frame — a `file:` frame that sensitive host channels must refuse. */
export function pluginShellFrameEvent(): IpcMainInvokeEvent {
  return foreignFrameEvent(PLUGIN_SHELL_FRAME_URL);
}

/**
 * An event whose sender frame is gone — what Electron delivers once the sending
 * frame is destroyed or navigated away between `invoke` and handler execution.
 * Every guard must refuse it.
 */
export function framelessEvent(): IpcMainInvokeEvent {
  return { senderFrame: null, sender: {} } as unknown as IpcMainInvokeEvent;
}

type RegisteredHandler = (...args: unknown[]) => unknown;

export function invokeRegisteredHandler<T = unknown>(
  handlers: Map<string, RegisteredHandler>,
  channel: string,
  ...args: unknown[]
): T {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return fn(hostFrameEvent(), ...args) as T;
}

export function invokeRegisteredHandlerWithEvent<T = unknown>(
  handlers: Map<string, RegisteredHandler>,
  channel: string,
  event: unknown,
  ...args: unknown[]
): T {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return fn(event, ...args) as T;
}

export function makeMockPermissionManager() {
  return {
    getMode: vi.fn(() => "default"),
    setModePersist: vi.fn(),
    listPersistedRules: vi.fn(async () => []),
    addAlwaysAllowedPersist: vi.fn(),
    addAlwaysDeniedPersist: vi.fn(),
    removeRule: vi.fn(),
    getVisibilityDenyRules: vi.fn(() => []),
  };
}

export function makeMockConversationLoop(
  permissionManager: ReturnType<typeof makeMockPermissionManager>,
) {
  return {
    permissionManager,
    hasProvider: vi.fn(),
    runTurn: vi.fn(),
    newConversation: vi.fn(),
    getSessionId: vi.fn(() => "s1"),
    listSessions: vi.fn(() => []),
    loadSession: vi.fn(),
    refreshProvider: vi.fn(),
  };
}

export function makeMockApprovalGate() {
  return { resolve: vi.fn(), setPolicy: vi.fn() };
}

export function createInMemoryFeatureNamespace() {
  let stored: unknown;
  const handle = {
    dir: "memory",
    readJson: async <T>(_name: string, fallback: T): Promise<T> =>
      structuredClone(stored === undefined ? fallback : stored) as T,
    writeJson: async <T>(_name: string, value: T): Promise<void> => {
      stored = structuredClone(value);
    },
    childDir: async (name: string): Promise<string> => name,
  } satisfies FeatureNamespaceHandle;
  return {
    handle,
    getStored: () => structuredClone(stored),
  };
}

export async function collectAsyncIterable<T>(
  iterable: AsyncIterable<T>,
): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

export interface RecordedSpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: SpawnOptions;
}

export function makeRecordedSpawn(
  child: ChildProcess,
  calls: RecordedSpawnCall[],
): (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => ChildProcess {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
}

/**
 * A live (non-destroyed) BrowserWindow stand-in for IPC fan-out assertions.
 * Shared so window-broadcast suites do not each re-declare the same shape.
 */
export interface FakeBrowserWindow {
  isDestroyed: () => boolean;
  webContents: { isDestroyed: () => boolean; send: (channel: string, payload?: unknown) => void };
}

export function liveWindow(): FakeBrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  };
}

/**
 * Run `fn` with `process.env.TZ` pinned to `zone`, restoring the previous value
 * afterwards — for a sync `fn` on return, for an async one when its promise
 * settles. Node re-reads `TZ` on assignment for both `Date` and the `Intl`
 * default, so no other setup is needed.
 *
 * Every civil-calendar assertion has to pin the zone or it asserts nothing
 * beyond "the machine running the suite agrees with itself". Three suites
 * carried the same `withTz` plus a `beforeEach`/`afterEach` pair to undo it;
 * this is the one owner and it undoes itself.
 */
export function withTz<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ;
  const restore = (): void => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  };
  process.env.TZ = zone;
  let result: T;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(restore) as T;
  }
  restore();
  return result;
}
