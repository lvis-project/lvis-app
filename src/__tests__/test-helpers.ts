import { vi } from "vitest";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { IpcMainInvokeEvent } from "electron";
import { IPC_APPROVAL_REQUEST } from "../permissions/approval-gate.js";
import type { FeatureNamespaceHandle } from "../main/storage/feature-namespace.js";
import type { ChatEntry } from "../lib/chat-stream-state.js";
import { SessionGoalStore } from "../main/session-goal-store.js";
import type { SessionGoal } from "../shared/session-goal.js";

export function makeMockWebContents() {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

/**
 * The approval CARDS a gate sent to this renderer, in order.
 *
 * The same webContents also carries settlement announcements
 * (`lvis:approval:settled`), so an index into the raw call log reads one of
 * those as a card as soon as an earlier request ends. Suites that count or
 * index the cards select them through here.
 */
export function sentApprovalCards<T>(
  wc: ReturnType<typeof makeMockWebContents>,
): T[] {
  return wc.send.mock.calls
    .map((call) => call as unknown as [string, T])
    .filter(([channel]) => channel === IPC_APPROVAL_REQUEST)
    .map(([, payload]) => payload);
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

/**
 * A frame from a page the host never loads — the canonical "wrong sender" for a
 * gated channel. Every guard must refuse it.
 */
export function untrustedEvent(): IpcMainInvokeEvent {
  return foreignFrameEvent("https://evil.example.com/");
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Read a file by its repo-relative path, for source-discipline suites that
 * assert on what is checked in (workflows, styles, scripts) rather than on
 * behaviour. Anchored on this file's location, not `process.cwd()`, so a
 * suite run from another working directory reads the same repo.
 */
export function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

/** A user transcript entry — the minimal shape every transcript suite starts from. */
export function userEntry(text: string): ChatEntry {
  return { kind: "user", text };
}

/** A settled (non-streaming) assistant entry with the given body. */
export function assistantEntry(text: string): Extract<ChatEntry, { kind: "assistant" }> {
  return { kind: "assistant", text, streaming: false };
}

/** Let un-awaited work that was queued with setImmediate run before asserting on it. */
export function settleMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Override `process.platform` for a platform-branching subject. The caller
 * owns restoring the real value in its own afterEach.
 */
export function setProcessPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

/** Parse a tool's JSON text output as a keyed record. */
export function parseJsonRecord(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

/**
 * The file's identity and its bytes, read through ONE open handle.
 *
 * The atomic-write tests assert that a rewrite REPLACED the file: a new inode
 * carrying the new bytes. Statting the path and then reading the path asks the
 * directory twice, so the two answers can describe different files — the race
 * those very tests exist to prove the writer avoids. Opening once and asking
 * the descriptor makes the inode and the bytes the same file by construction.
 */
export function inspectFile(path: string): { ino: number; mode: number; text: string } {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    return { ino: stat.ino, mode: stat.mode & 0o777, text: readFileSync(fd, "utf-8") };
  } finally {
    closeSync(fd);
  }
}

/**
 * A {@link SessionGoalStore} over an in-memory sidecar.
 *
 * One home rather than a copy per suite: the fake stands in for the persistence
 * the real store commits to before it touches memory, and two copies of it are
 * two ways for that contract to drift from the store it is standing in for.
 *
 * `disk` is returned so a test can prove a restart reads the goal back, and
 * `now` so timestamps can be made deterministic; both are optional because
 * most callers only need the store.
 */
export function makeSessionGoalStore(now?: () => string): {
  store: SessionGoalStore;
  /** The sidecar the store wrote through, keyed by session id. */
  disk: Map<string, SessionGoal | null>;
} {
  const disk = new Map<string, SessionGoal | null>();
  const persistence = {
    load: (sessionId: string) => disk.get(sessionId) ?? null,
    save: async (sessionId: string, goal: SessionGoal | null) => {
      disk.set(sessionId, goal);
    },
  };
  return {
    store: now ? new SessionGoalStore(persistence, now) : new SessionGoalStore(persistence),
    disk,
  };
}
