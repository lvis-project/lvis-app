import { afterAll, vi } from "vitest";
import { createServer as createNetServer } from "node:net";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpDirTracker } from "./support/tmp-dir-teardown.js";
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
 *
 * Typed against the call log rather than against {@link makeMockWebContents},
 * because a suite whose mock takes its own options (a destroyed renderer, a
 * `send` that throws) still sends the same cards.
 */
export function sentApprovalCards<T>(
  wc: { send: { mock: { calls: unknown[][] } } },
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

/**
 * {@link invokeRegisteredHandlerWithEvent} bound to one handler map, for a
 * suite that registers once and then drives many channels.
 *
 * The suites that wanted this had each written the map lookup out again as a
 * local `invoke`, which is a third copy of "what a missing handler does".
 */
export function makeRegisteredHandlerInvoker(
  handlers: Map<string, RegisteredHandler>,
): <T = unknown>(channel: string, event: unknown, ...args: unknown[]) => T {
  return (channel, event, ...args) =>
    invokeRegisteredHandlerWithEvent(handlers, channel, event, ...args);
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
    setDeferredEntryAsk: vi.fn(),
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

/**
 * A factory for scratch directories under the OS temp dir, removed together
 * when the suite finishes.
 *
 * Fourteen suites each carried the same three lines — `mkdtempSync`, push onto
 * a suite-local array, return it — plus a hook to drain that array. The array
 * is the part worth removing: each copy is another place a teardown can be
 * written wrong or forgotten, and the directory a suite makes is the same
 * artifact in every one of them. Registering the `afterAll` here means a suite
 * declares only what it creates.
 *
 * `prefix` labels the suite's directories. A call may pass its own label when
 * one suite makes directories for more than one purpose, which is why the four
 * suites that took the prefix per call fold into the same helper as the ten
 * that fixed it once.
 *
 * Removal goes through {@link createTmpDirTracker}, not a second `rm` ladder:
 * the transient-lock retry that teardown needs has one owner
 * (`support/tmp-dir-teardown.ts`) and a copy here is what that file exists to
 * prevent.
 */
export function useTempDirs(prefix: string): (ownPrefix?: string) => string {
  const tracker = createTmpDirTracker();
  afterAll(async () => {
    await tracker.cleanup();
  });
  return (ownPrefix = prefix) => tracker.track(mkdtempSync(join(tmpdir(), ownPrefix)));
}

/**
 * A factory for paths to `fileName`, each inside a fresh scratch directory this
 * suite owns. The path is returned, not created: the subject under test is what
 * creates it, which is what those suites are asserting about.
 *
 * The suites that wanted this wrapped {@link useTempDirs} in a local function so
 * their call sites could stay bare. The wrapper is the duplicated part; the
 * prefix and the file name are not, and stay at the one place a suite names its
 * subject. `PermissionTestResources.tmpFilePaths` is the same shape for suites
 * whose cleanup is owned by that instance rather than by a hook.
 */
export function useTempPaths(prefix: string, fileName: string): () => string {
  const makeDir = useTempDirs(prefix);
  return () => join(makeDir(), fileName);
}

/**
 * A fresh scratch directory this suite owns, plus a path to `fileName` inside
 * it. Neither is created beyond the directory itself: the subject under test
 * writes the file, which is what those suites assert about.
 *
 * The pair is the helper because the suites that wanted it assert on both — a
 * settings file and the root it sits under, where the root is also the
 * workspace directory the settings name. {@link useTempPaths} is the same
 * helper for a suite that needs only the path.
 */
export function useTempDirFile(
  prefix: string,
  fileName: string,
): () => { dir: string; path: string } {
  const makeDir = useTempDirs(prefix);
  return () => {
    const dir = makeDir();
    return { dir, path: join(dir, fileName) };
  };
}

/**
 * A promise plus the handle that settles it, for a test that must observe work
 * mid-flight — start the call, assert on the state it is now in, then resolve.
 *
 * Three suites wrote this out; the only thing that differed between them was the
 * name of the executor's parameter. `Promise.withResolvers` is the same object,
 * but it is ES2024 and this tree compiles against `lib: ES2023`.
 */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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

/**
 * Hold a real loopback port for the duration of one test.
 *
 * Two suites arrange the same precondition — "this port is taken" — and a
 * second copy of the arrangement is a second definition of what "taken" means.
 * A port the machine running the suite already uses satisfies the precondition
 * on its own, so that case releases nothing rather than failing the test for
 * the very condition it is arranging.
 */
export async function occupyLoopbackPort(port: number): Promise<() => Promise<void>> {
  const held = createNetServer();
  const bound = await new Promise<boolean>((resolve, reject) => {
    held.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") resolve(false);
      else reject(err);
    });
    held.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(true));
  });
  if (!bound) return async () => undefined;
  return () => new Promise<void>((resolve) => held.close(() => resolve()));
}
