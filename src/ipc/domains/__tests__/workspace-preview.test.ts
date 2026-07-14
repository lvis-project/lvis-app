import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const {
  handlers,
  showOpenDialogMock,
  showItemInFolderMock,
  addAllowedDirectoryPersistMock,
  removeAllowedDirectoryPersistMock,
  beginWorkspaceRootRemovalPersistMock,
  completeWorkspaceRootRemovalPersistMock,
  additionalDirectories,
  pendingWorkspaceRootRemovals,
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialogMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
  addAllowedDirectoryPersistMock: vi.fn(async () => [] as string[]),
  removeAllowedDirectoryPersistMock: vi.fn(async (dir: string) => {
    additionalDirectories.value = additionalDirectories.value.filter((d) => d !== dir);
    return additionalDirectories.value;
  }),
  beginWorkspaceRootRemovalPersistMock: vi.fn(),
  completeWorkspaceRootRemovalPersistMock: vi.fn(),
  additionalDirectories: { value: [] as string[] },
  pendingWorkspaceRootRemovals: { value: [] as Array<{
    operationId: string;
    storedPath: string;
    runtimePath: string;
    requestedAt: string;
    source: string;
  }> },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: { showOpenDialog: showOpenDialogMock },
  shell: { showItemInFolder: showItemInFolderMock },
}));

vi.mock("../../../permissions/permission-settings-store.js", () => ({
  readPermissionSettings: () => ({
    permissions: {
      additionalDirectories: additionalDirectories.value,
      pendingWorkspaceRootRemovals: pendingWorkspaceRootRemovals.value,
    },
  }),
  addAllowedDirectoryPersist: addAllowedDirectoryPersistMock,
  removeAllowedDirectoryPersist: removeAllowedDirectoryPersistMock,
  beginWorkspaceRootRemovalPersist: beginWorkspaceRootRemovalPersistMock,
  completeWorkspaceRootRemovalPersist: completeWorkspaceRootRemovalPersistMock,
}));

import { registerPreviewHandlers } from "../preview.js";
import { registerWorkspaceHandlers } from "../workspace.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { canonicalizePathForMatch } from "../../../permissions/sensitive-paths.js";

const deps = {
  auditLogger: { log: vi.fn() },
  getMainWindow: () => null,
  memoryManager: {
    allowProjectRoot: vi.fn(),
    detachSessionsFromProject: vi.fn(async () => 0),
  },
  conversationLoop: {
    deps: {},
    permissionManager: { prunePathGrantsUnderRoot: async () => [] },
    revokeWorkspaceRoot: () => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    }),
  },
  routinesStore: {
    revokeWorkspaceRoot: async () => ({ routinesUpdated: 0, directoriesRemoved: 0 }),
  },
} as never;

function invoke(channel: string, url: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return Promise.resolve(fn({ senderFrame: { url } } as never, ...args));
}

const OK_FRAME = "file:///app/index.html";
const EVIL_FRAME = "https://evil.example.com/x";
const dirLinkType = process.platform === "win32" ? "junction" : "dir";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lvis-ws-preview-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "architecture.md"), "# Architecture\n\nreal content\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x00, 0x01]));
  additionalDirectories.value = [root];
  registerPreviewHandlers(deps);
  registerWorkspaceHandlers(deps);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  showOpenDialogMock.mockReset();
  showItemInFolderMock.mockReset();
  addAllowedDirectoryPersistMock.mockClear();
  removeAllowedDirectoryPersistMock.mockClear();
  beginWorkspaceRootRemovalPersistMock.mockReset();
  completeWorkspaceRootRemovalPersistMock.mockReset();
  additionalDirectories.value = [root];
  pendingWorkspaceRootRemovals.value = [];
  let operationSequence = 0;
  const key = (value: string) => value.replace(/\\/g, "/").toLowerCase();
  beginWorkspaceRootRemovalPersistMock.mockImplementation(async (
    target: string,
    source: string,
  ) => {
    const existing = pendingWorkspaceRootRemovals.value.find(
      (intent) => key(intent.runtimePath) === key(target),
    );
    const storedPath = additionalDirectories.value.find(
      (candidate) => key(candidate) === key(target),
    );
    if (!storedPath) {
      return existing
        ? { intent: existing, activeDirectories: additionalDirectories.value, created: false }
        : null;
    }
    operationSequence += 1;
    const intent = existing ?? {
      operationId: `00000000-0000-4000-8000-${String(operationSequence).padStart(12, "0")}`,
      storedPath,
      runtimePath: target,
      requestedAt: new Date(0).toISOString(),
      source,
    };
    additionalDirectories.value = additionalDirectories.value.filter(
      (candidate) => key(candidate) !== key(target),
    );
    if (!existing) pendingWorkspaceRootRemovals.value.push(intent);
    return { intent, activeDirectories: additionalDirectories.value, created: !existing };
  });
  completeWorkspaceRootRemovalPersistMock.mockImplementation(async (operationId: string) => {
    const before = pendingWorkspaceRootRemovals.value.length;
    pendingWorkspaceRootRemovals.value = pendingWorkspaceRootRemovals.value.filter(
      (intent) => intent.operationId !== operationId,
    );
    return pendingWorkspaceRootRemovals.value.length !== before;
  });
});

describe("preview:read-file handler", () => {
  it("reads a file inside an allowed project root", async () => {
    const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, join(root, "docs", "architecture.md"))) as {
      ok: boolean;
      content?: string;
    };
    expect(res.ok).toBe(true);
    expect(res.content).toContain("real content");
  });

  it("rejects an unauthorized sender frame (fail-closed)", async () => {
    const res = (await invoke(CHANNELS.preview.readFile, EVIL_FRAME, join(root, "docs", "architecture.md"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("rejects a glob pattern as not-a-file", async () => {
    const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, "**/*architecture*.md")) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "not-a-file" });
  });

  it("hard-blocks a Layer 0 sensitive path", async () => {
    const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, join(homedir(), ".ssh", "id_rsa"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "sensitive-path" });
  });

  it("rejects a path outside every allowed root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lvis-ws-outside-"));
    writeFileSync(join(outside, "secret.txt"), "nope");
    additionalDirectories.value = []; // only cwd + ~/.lvis remain in scope
    const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, join(outside, "secret.txt"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "path-not-allowed" });
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a binary file", async () => {
    const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, join(root, "bin.dat"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "binary-file" });
  });

  it("refuses a file over the text size cap (too-large, fail-closed)", async () => {
    // The preview read shares read_file's MAX_TEXT_FILE_BYTES (2MB) cap — a file
    // above it is refused BEFORE buffering so a huge file can't be pulled across
    // the sandbox boundary for display. #1445 size-cap guard.
    const big = join(root, "huge.txt");
    writeFileSync(big, "a".repeat(2_000_001));
    try {
      const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, big)) as {
        ok: boolean;
        error?: string;
        bytes?: number;
      };
      expect(res).toMatchObject({ ok: false, error: "too-large" });
      expect(res.bytes).toBeGreaterThan(2_000_000);
    } finally {
      rmSync(big, { force: true });
    }
  });

  it("rejects a symlink whose real target escapes the allowed root", async () => {
    // A symlink INSIDE the allowed root that points OUT of it must not become a
    // read hole: the guard realpath's the link before the boundary check, so the
    // escaped target is what gets validated (and rejected).
    const outside = mkdtempSync(join(tmpdir(), "lvis-ws-symlink-outside-"));
    writeFileSync(join(outside, "secret.txt"), "escaped secret");
    const link = join(root, "escape-link");
    symlinkSync(outside, link, dirLinkType);
    const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, join(link, "secret.txt"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "path-not-allowed" });
    rmSync(link, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("writes an audit entry for a successful preview read", async () => {
    const log = (deps as unknown as { auditLogger: { log: ReturnType<typeof vi.fn> } }).auditLogger.log;
    log.mockClear();
    const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, join(root, "docs", "architecture.md"))) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        input: expect.stringContaining(CHANNELS.preview.readFile),
      }),
    );
  });
});

describe("workspace handlers", () => {
  it("listRoots returns the default root plus persisted additions", async () => {
    const res = (await invoke(CHANNELS.workspace.listRoots, OK_FRAME)) as {
      ok: boolean;
      defaultRoot?: string;
      roots?: Array<{ path: string; isDefault: boolean }>;
    };
    expect(res.ok).toBe(true);
    expect(res.defaultRoot).toBe(process.cwd());
    expect(res.roots?.[0]).toMatchObject({ path: process.cwd(), isDefault: true });
    expect(res.roots?.some((r) => !r.isDefault)).toBe(true);
  });


  it("listRoots prunes a confirmed missing project folder at runtime", async () => {
    const missingRoot = join(
      tmpdir(),
      `lvis-missing-root-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    rmSync(missingRoot, { recursive: true, force: true });
    additionalDirectories.value = [missingRoot];

    const res = (await invoke(CHANNELS.workspace.listRoots, OK_FRAME)) as {
      ok: boolean;
      roots?: Array<{ path: string; isDefault: boolean }>;
    };

    expect(res.ok).toBe(true);
    expect(beginWorkspaceRootRemovalPersistMock).toHaveBeenCalledWith(
      missingRoot,
      "list-roots",
      undefined,
    );
    expect(completeWorkspaceRootRemovalPersistMock).toHaveBeenCalledTimes(1);
    expect(res.roots?.some((entry) => entry.path === missingRoot)).toBe(false);
  });

  it("listRoots keeps a missing root inactive and pending when grant cleanup fails", async () => {
    const missingRoot = join(
      tmpdir(),
      `lvis-missing-root-fail-closed-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    rmSync(missingRoot, { recursive: true, force: true });
    additionalDirectories.value = [missingRoot];
    const log = vi.fn();
    const revokeWorkspaceRoot = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    }));
    const detachSessionsFromProject = vi.fn(async () => 0);
    const lifecycleDeps = {
      auditLogger: { log },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject },
      conversationLoop: {
        permissionManager: {
          prunePathGrantsUnderRoot: vi.fn(async () => {
            throw Object.assign(new Error("must-not-leak-list-path"), { code: "EIO" });
          }),
        },
        revokeWorkspaceRoot,
      },
      routinesStore: {
        revokeWorkspaceRoot: vi.fn(async () => ({
          routinesUpdated: 0,
          directoriesRemoved: 0,
        })),
      },
    } as never;
    registerWorkspaceHandlers(lifecycleDeps);

    try {
      const res = (await invoke(CHANNELS.workspace.listRoots, OK_FRAME)) as {
        ok: boolean;
        roots?: Array<{ path: string; isDefault: boolean }>;
        cleanupPending?: number;
      };
      expect(res.ok).toBe(true);
      expect(res.cleanupPending).toBe(1);
      expect(res.roots?.some((entry) => entry.path === missingRoot)).toBe(false);
      expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(additionalDirectories.value).toEqual([]);
      expect(pendingWorkspaceRootRemovals.value).toHaveLength(1);
      expect(revokeWorkspaceRoot).toHaveBeenCalled();
      expect(detachSessionsFromProject).toHaveBeenCalledTimes(1);
      const warningPayloads = log.mock.calls
        .map(([entry]) => entry as { type?: string; input?: string; output?: string })
        .filter((entry) => entry.type === "warn")
        .map((entry) => `${entry.input ?? ""}\n${entry.output ?? ""}`);
      expect(warningPayloads.some((payload) => payload.includes("cleanup-pending"))).toBe(true);
      expect(warningPayloads.join("\n")).not.toContain("must-not-leak-list-path");
      expect(warningPayloads.join("\n")).not.toContain(missingRoot);
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("listDir lists entries inside an allowed root (dirs first)", async () => {
    const res = (await invoke(CHANNELS.workspace.listDir, OK_FRAME, root)) as {
      ok: boolean;
      entries?: Array<{ name: string; type: string }>;
    };
    expect(res.ok).toBe(true);
    expect(res.entries?.[0]).toMatchObject({ name: "docs", type: "directory" });
    expect(res.entries?.some((e) => e.name === "bin.dat" && e.type === "file")).toBe(true);
  });

  it("listDir rejects a path outside the allowed roots", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lvis-ws-outside-list-"));
    additionalDirectories.value = [];
    const res = (await invoke(CHANNELS.workspace.listDir, OK_FRAME, outside)) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "path-not-allowed" });
    rmSync(outside, { recursive: true, force: true });
  });

  it("pickRoot persists the chosen directory to additionalDirectories", async () => {
    const picked = mkdtempSync(join(tmpdir(), "lvis-ws-picked-"));
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [picked] });
    const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as {
      ok: boolean;
      added?: string;
    };
    expect(res).toMatchObject({ ok: true, added: canonicalizePathForMatch(picked) });
    expect(addAllowedDirectoryPersistMock).toHaveBeenCalledWith(canonicalizePathForMatch(picked));
    rmSync(picked, { recursive: true, force: true });
  });

  it("central allow lifecycle rejects files and missing folders for picker/slash/Settings parity", async () => {
    const filePath = join(root, "not-a-workspace-root.txt");
    const missingPath = join(root, "missing-workspace-root");
    writeFileSync(filePath, "not a directory");
    const lifecycle = (deps as unknown as {
      workspaceRootLifecycle?: {
        allowDirectory: (
          rootPath: string,
          source: "permission-slash",
        ) => Promise<string[]>;
      };
    }).workspaceRootLifecycle;

    try {
      expect(lifecycle).toBeDefined();
      await expect(
        lifecycle!.allowDirectory(filePath, "permission-slash"),
      ).rejects.toThrow("workspace-root-not-directory");
      await expect(
        lifecycle!.allowDirectory(missingPath, "permission-slash"),
      ).rejects.toThrow("workspace-root-not-found");
      expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  it("treats picking an already-registered root as a no-op without pruning grants or routine scopes", async () => {
    const prunePathGrants = vi.fn(async () => []);
    const pruneRoutineScopes = vi.fn(async () => ({
      routinesUpdated: 0,
      directoriesRemoved: 0,
    }));
    const lifecycleDeps = {
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      conversationLoop: { permissionManager: { prunePathGrantsUnderRoot: prunePathGrants } },
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never;
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [root] });
    registerWorkspaceHandlers(lifecycleDeps);

    try {
      const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as {
        ok: boolean;
        added?: string;
      };
      expect(res).toMatchObject({ ok: true, added: canonicalizePathForMatch(root) });
      expect(prunePathGrants).not.toHaveBeenCalled();
      expect(pruneRoutineScopes).not.toHaveBeenCalled();
      expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(additionalDirectories.value).toEqual([root]);
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("pre-cleans stale grants and routine scopes before persisting a genuine add", async () => {
    const picked = mkdtempSync(join(tmpdir(), "lvis-ws-readd-"));
    const prunePathGrants = vi.fn(async () => []);
    const pruneRoutineScopes = vi.fn(async () => ({
      routinesUpdated: 0,
      directoriesRemoved: 0,
    }));
    const lifecycleDeps = {
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: prunePathGrants },
      },
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never;
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [picked] });
    registerWorkspaceHandlers(lifecycleDeps);

    try {
      const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as {
        ok: boolean;
        added?: string;
      };
      const canonical = canonicalizePathForMatch(picked);
      expect(res).toMatchObject({ ok: true, added: canonical });
      expect(prunePathGrants).toHaveBeenCalledWith(canonical, {
        preserveRoots: [],
      });
      expect(pruneRoutineScopes).toHaveBeenCalledWith(canonical, {
        preserveRoots: [],
      });
      expect(prunePathGrants.mock.invocationCallOrder[0]).toBeLessThan(
        addAllowedDirectoryPersistMock.mock.invocationCallOrder[0]!,
      );
      expect(pruneRoutineScopes.mock.invocationCallOrder[0]).toBeLessThan(
        addAllowedDirectoryPersistMock.mock.invocationCallOrder[0]!,
      );
    } finally {
      registerWorkspaceHandlers(deps);
      rmSync(picked, { recursive: true, force: true });
    }
  });

  it("pre-cleans a parent re-add without pruning a registered child project", async () => {
    const parentRoot = mkdtempSync(join(tmpdir(), "lvis-ws-readd-parent-"));
    const childRoot = join(parentRoot, "child");
    mkdirSync(childRoot);
    additionalDirectories.value = [childRoot];
    const prunePathGrants = vi.fn(async () => []);
    const pruneRoutineScopes = vi.fn(async () => ({
      routinesUpdated: 0,
      directoriesRemoved: 0,
    }));
    registerWorkspaceHandlers({
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: prunePathGrants },
      },
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never);
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [parentRoot] });

    try {
      const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as {
        ok: boolean;
        added?: string;
      };
      const canonicalParent = canonicalizePathForMatch(parentRoot);
      const canonicalChild = canonicalizePathForMatch(childRoot);
      const pruneOptions = { preserveRoots: [canonicalChild] };
      expect(res).toMatchObject({ ok: true, added: canonicalParent });
      expect(prunePathGrants).toHaveBeenCalledWith(canonicalParent, pruneOptions);
      expect(pruneRoutineScopes).toHaveBeenCalledWith(canonicalParent, pruneOptions);
      expect(addAllowedDirectoryPersistMock).toHaveBeenCalledWith(canonicalParent);
    } finally {
      registerWorkspaceHandlers(deps);
      rmSync(parentRoot, { recursive: true, force: true });
    }
  });

  it("pickRoot returns canceled without persisting when the dialog is dismissed", async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });
    const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as { ok: boolean; canceled?: boolean };
    expect(res).toMatchObject({ ok: true, canceled: true });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("pickRoot does NOT persist an adjacency-warned path until it is acknowledged (token flow)", async () => {
    // A directory whose path carries a `.git` segment trips an adjacency warning
    // (not a hard deny) — the pick must be withheld from the read allow-list
    // until the renderer confirms by echoing the one-time token.
    const base = mkdtempSync(join(tmpdir(), "lvis-ws-warn-"));
    const warnDir = join(base, ".git");
    mkdirSync(warnDir);
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [warnDir] });

    const first = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as {
      ok: boolean;
      requiresAcknowledgement?: boolean;
      pendingPath?: string;
      ackToken?: string;
      warnings?: string[];
      added?: string;
    };
    expect(first.ok).toBe(true);
    expect(first.requiresAcknowledgement).toBe(true);
    expect(first.pendingPath).toBe(warnDir);
    expect(typeof first.ackToken).toBe("string");
    expect((first.ackToken ?? "").length).toBeGreaterThan(0);
    expect((first.warnings ?? []).length).toBeGreaterThan(0);
    expect(first.added).toBeUndefined();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();

    // Second, explicit confirmation echoes the TOKEN (not a path) and persists
    // WITHOUT reopening the dialog.
    showOpenDialogMock.mockClear();
    const second = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: first.ackToken })) as {
      ok: boolean;
      added?: string;
    };
    expect(second).toMatchObject({ ok: true, added: canonicalizePathForMatch(warnDir) });
    expect(showOpenDialogMock).not.toHaveBeenCalled();
    expect(addAllowedDirectoryPersistMock).toHaveBeenCalledWith(canonicalizePathForMatch(warnDir));

    rmSync(base, { recursive: true, force: true });
  });

  it("pickRoot REFUSES an ack token that was never issued by a dialog pick (forged/unknown)", async () => {
    // A compromised renderer cannot forge a token: without a main-process-held
    // pending entry the ack pass is refused and NOTHING is persisted, so it can
    // never self-clear adjacency warnings for a directory of its own choosing.
    const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, {
      ackToken: "forged-token-never-minted",
    })) as { ok: boolean; error?: string; added?: string };
    expect(res).toMatchObject({ ok: false, error: "ack-unknown" });
    expect(res.added).toBeUndefined();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
    // Dialog is NEVER reopened on a bogus ack — a forged token can't trigger a
    // fresh pick either.
    expect(showOpenDialogMock).not.toHaveBeenCalled();
  });

  it("pickRoot is a ONE-TIME token — a replayed token is refused after first use", async () => {
    const base = mkdtempSync(join(tmpdir(), "lvis-ws-replay-"));
    const warnDir = join(base, ".git");
    mkdirSync(warnDir);
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [warnDir] });

    const first = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as { ackToken?: string };
    const token = first.ackToken;
    const ok = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: token })) as {
      ok: boolean;
      added?: string;
    };
    expect(ok).toMatchObject({ ok: true, added: canonicalizePathForMatch(warnDir) });

    addAllowedDirectoryPersistMock.mockClear();
    const replay = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: token })) as {
      ok: boolean;
      error?: string;
    };
    expect(replay).toMatchObject({ ok: false, error: "ack-unknown" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();

    rmSync(base, { recursive: true, force: true });
  });

  it("pickRoot REFUSES an expired ack token (TTL elapsed)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const base = mkdtempSync(join(tmpdir(), "lvis-ws-expire-"));
      const warnDir = join(base, ".git");
      mkdirSync(warnDir);
      showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [warnDir] });

      const first = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as { ackToken?: string };
      const token = first.ackToken;

      // Advance past the 60s acknowledgement window.
      vi.setSystemTime(Date.now() + 61_000);
      addAllowedDirectoryPersistMock.mockClear();
      const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: token })) as {
        ok: boolean;
        error?: string;
        added?: string;
      };
      expect(res).toMatchObject({ ok: false, error: "ack-expired" });
      expect(res.added).toBeUndefined();
      expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();

      rmSync(base, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pickRoot audits the allow-list widening on a successful persist", async () => {
    const log = (deps as unknown as { auditLogger: { log: ReturnType<typeof vi.fn> } }).auditLogger.log;
    log.mockClear();
    const picked = mkdtempSync(join(tmpdir(), "lvis-ws-audit-"));
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [picked] });
    const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as { ok: boolean; added?: string };
    expect(res).toMatchObject({ ok: true, added: canonicalizePathForMatch(picked) });
    // The read-scope WRITE is audited (redacted path), mirroring the preview READ.
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        input: expect.stringContaining(CHANNELS.workspace.pickRoot),
      }),
    );
    rmSync(picked, { recursive: true, force: true });
  });

  it("listDir omits Layer 0 sensitive entries inside an allowed root", async () => {
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    const res = (await invoke(CHANNELS.workspace.listDir, OK_FRAME, root)) as {
      ok: boolean;
      entries?: Array<{ name: string }>;
    };
    expect(res.ok).toBe(true);
    expect(res.entries?.some((e) => e.name === ".env")).toBe(false);
    rmSync(join(root, ".env"), { force: true });
  });

  it("removeRoot removes an additional root and audits the shrink", async () => {
    const log = (deps as unknown as { auditLogger: { log: ReturnType<typeof vi.fn> } }).auditLogger.log;
    log.mockClear();
    const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
      ok: boolean;
      removed?: string;
      roots?: Array<{ path: string; isDefault: boolean }>;
    };
    expect(res).toMatchObject({ ok: true, removed: root });
    expect(beginWorkspaceRootRemovalPersistMock).toHaveBeenCalledWith(
      canonicalizePathForMatch(root),
      CHANNELS.workspace.removeRoot,
      undefined,
    );
    expect(completeWorkspaceRootRemovalPersistMock).toHaveBeenCalledTimes(1);
    expect(res.roots?.some((r) => r.path === root)).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        input: expect.stringContaining(CHANNELS.workspace.removeRoot),
      }),
    );
  });

  it("removes a parent project while preserving a separately registered child root", async () => {
    const parentRoot = mkdtempSync(join(tmpdir(), "lvis-ws-nested-parent-"));
    const childRoot = join(parentRoot, "child");
    mkdirSync(childRoot);
    const canonicalParent = canonicalizePathForMatch(parentRoot);
    const canonicalChild = canonicalizePathForMatch(childRoot);
    additionalDirectories.value = [parentRoot, childRoot];
    const prunePathGrants = vi.fn(async () => []);
    const pruneRoutineScopes = vi.fn(async () => ({
      routinesUpdated: 0,
      directoriesRemoved: 0,
    }));
    const revokeWorkspaceRoot = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    }));
    const routineRevokeWorkspaceRoot = vi.fn(() => ({
      activeLoopsVisited: 0,
      liveScopesRevoked: 0,
    }));
    const detachSessionsFromProject = vi.fn(async () => 1);
    registerWorkspaceHandlers({
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject },
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: prunePathGrants },
        revokeWorkspaceRoot,
      },
      routineEngine: { revokeWorkspaceRoot: routineRevokeWorkspaceRoot },
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never);

    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, parentRoot)) as {
        ok: boolean;
        roots?: Array<{ path: string; isDefault: boolean }>;
      };
      const pruneOptions = { preserveRoots: [canonicalChild] };
      const liveOptions = {
        globalScopeWasAuthorized: true,
        preserveRoots: [canonicalChild],
      };
      expect(res.ok).toBe(true);
      expect(additionalDirectories.value).toEqual([childRoot]);
      expect(res.roots?.some((entry) => entry.path === canonicalChild)).toBe(true);
      expect(prunePathGrants).toHaveBeenCalledWith(canonicalParent, pruneOptions);
      expect(pruneRoutineScopes).toHaveBeenCalledWith(canonicalParent, pruneOptions);
      expect(revokeWorkspaceRoot).toHaveBeenCalledWith(canonicalParent, liveOptions);
      expect(routineRevokeWorkspaceRoot).toHaveBeenCalledWith(canonicalParent, liveOptions);
      expect(detachSessionsFromProject).toHaveBeenCalledWith(canonicalParent);
      expect(detachSessionsFromProject).not.toHaveBeenCalledWith(canonicalChild);
    } finally {
      registerWorkspaceHandlers(deps);
      rmSync(parentRoot, { recursive: true, force: true });
    }
  });


  it("cuts over, revokes live scope, prunes durable scope, detaches sessions, then completes", async () => {
    const revokeWorkspaceRoot = vi.fn(() => ({
      sessionDirectoriesRemoved: 1,
      turnDirectoriesRemoved: 1,
      projectRebound: true,
    }));
    const routineRevokeWorkspaceRoot = vi.fn(() => ({
      activeLoopsVisited: 1,
      liveScopesRevoked: 3,
    }));
    const subAgentRevokeWorkspaceRoot = vi.fn(() => ({
      activeChildrenVisited: 2,
      liveScopesRevoked: 4,
    }));
    const subAgentDetachSessionsFromProject = vi.fn(async () => 1);
    const pruneRoutineScopes = vi.fn(async () => ({
      routinesUpdated: 1,
      directoriesRemoved: 2,
    }));
    const detachSessionsFromProject = vi.fn(async () => 2);
    const lifecycleDeps = {
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      memoryManager: {
        allowProjectRoot: vi.fn(),
        detachSessionsFromProject,
      },
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: vi.fn(async () => []) },
        revokeWorkspaceRoot,
      },
      routineEngine: { revokeWorkspaceRoot: routineRevokeWorkspaceRoot },
      getSubAgentRunner: () => ({
        detachSessionsFromProject: subAgentDetachSessionsFromProject,
        revokeWorkspaceRoot: subAgentRevokeWorkspaceRoot,
      }),
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never;
    registerWorkspaceHandlers(lifecycleDeps);
    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
      };
      expect(res.ok).toBe(true);
      const canonical = canonicalizePathForMatch(root);
      const liveOptions = {
        globalScopeWasAuthorized: true,
        preserveRoots: [],
      };
      expect(revokeWorkspaceRoot).toHaveBeenCalledWith(canonical, liveOptions);
      expect(routineRevokeWorkspaceRoot).toHaveBeenCalledWith(canonical, liveOptions);
      expect(subAgentRevokeWorkspaceRoot).toHaveBeenCalledWith(canonical, liveOptions);
      expect(pruneRoutineScopes).toHaveBeenCalledWith(canonical, {
        preserveRoots: [],
      });
      expect(pruneRoutineScopes).toHaveBeenCalledTimes(1);
      expect(detachSessionsFromProject).toHaveBeenCalledWith(canonicalizePathForMatch(root));
      expect(beginWorkspaceRootRemovalPersistMock.mock.invocationCallOrder[0]).toBeLessThan(
        revokeWorkspaceRoot.mock.invocationCallOrder[0]!,
      );
      expect(revokeWorkspaceRoot.mock.invocationCallOrder[0]).toBeLessThan(
        pruneRoutineScopes.mock.invocationCallOrder[0]!,
      );
      expect(pruneRoutineScopes.mock.invocationCallOrder[0]).toBeLessThan(
        detachSessionsFromProject.mock.invocationCallOrder[0]!,
      );
      expect(subAgentDetachSessionsFromProject.mock.invocationCallOrder[0]).toBeLessThan(
        completeWorkspaceRootRemovalPersistMock.mock.invocationCallOrder[0]!,
      );
      expect(detachSessionsFromProject.mock.invocationCallOrder[0]).toBeLessThan(
        completeWorkspaceRootRemovalPersistMock.mock.invocationCallOrder[0]!,
      );
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("attempts every live owner, keeps revoke failures pending, and completes on retry", async () => {
    const mainRevoke = vi.fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("main owner revoke failed"), { code: "EIO" });
      })
      .mockReturnValue({
        sessionDirectoriesRemoved: 1,
        turnDirectoriesRemoved: 0,
        projectRebound: false,
      });
    const sideRevoke = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 1,
      projectRebound: false,
    }));
    const routineRevoke = vi.fn(() => ({
      activeLoopsVisited: 1,
      liveScopesRevoked: 1,
    }));
    const subAgentRevoke = vi.fn(() => ({
      activeChildrenVisited: 1,
      liveScopesRevoked: 1,
    }));
    const primaryDetach = vi.fn(async () => 1);
    const sideDetach = vi.fn(async () => 1);
    const subAgentDetach = vi.fn(async () => 1);
    const pruneRoutineScopes = vi.fn(async () => ({
      routinesUpdated: 0,
      directoriesRemoved: 0,
    }));
    const prunePathGrants = vi.fn(async () => []);
    const subAgentRunner = {
      detachSessionsFromProject: subAgentDetach,
      revokeWorkspaceRoot: subAgentRevoke,
    };
    const lifecycleDeps = {
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject: primaryDetach },
      conversationLoop: {
        deps: {},
        permissionManager: { prunePathGrantsUnderRoot: prunePathGrants },
        revokeWorkspaceRoot: mainRevoke,
      },
      sideChatConversationLoop: {
        deps: { memoryManager: { detachSessionsFromProject: sideDetach } },
        revokeWorkspaceRoot: sideRevoke,
      },
      routineEngine: { revokeWorkspaceRoot: routineRevoke },
      getSubAgentRunner: () => subAgentRunner,
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never;
    registerWorkspaceHandlers(lifecycleDeps);

    try {
      const first = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };

      expect(first).toMatchObject({ ok: true, cleanupPending: true });
      expect(mainRevoke).toHaveBeenCalledTimes(1);
      expect(sideRevoke).toHaveBeenCalledTimes(1);
      expect(routineRevoke).toHaveBeenCalledTimes(1);
      expect(subAgentRevoke).toHaveBeenCalledTimes(1);
      expect(pruneRoutineScopes).toHaveBeenCalledTimes(1);
      expect(prunePathGrants).toHaveBeenCalledTimes(1);
      expect(primaryDetach).toHaveBeenCalledTimes(1);
      expect(sideDetach).toHaveBeenCalledTimes(1);
      expect(subAgentDetach).toHaveBeenCalledTimes(1);
      expect(pendingWorkspaceRootRemovals.value).toHaveLength(1);
      expect(completeWorkspaceRootRemovalPersistMock).not.toHaveBeenCalled();

      const second = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };

      expect(second).toMatchObject({ ok: true });
      expect(second.cleanupPending).toBeUndefined();
      expect(mainRevoke).toHaveBeenCalledTimes(2);
      expect(sideRevoke).toHaveBeenCalledTimes(2);
      expect(routineRevoke).toHaveBeenCalledTimes(2);
      expect(subAgentRevoke).toHaveBeenCalledTimes(2);
      expect(pruneRoutineScopes).toHaveBeenCalledTimes(2);
      expect(prunePathGrants).toHaveBeenCalledTimes(2);
      expect(primaryDetach).toHaveBeenCalledTimes(2);
      expect(sideDetach).toHaveBeenCalledTimes(2);
      expect(subAgentDetach).toHaveBeenCalledTimes(2);
      expect(completeWorkspaceRootRemovalPersistMock).toHaveBeenCalledTimes(1);
      expect(pendingWorkspaceRootRemovals.value).toEqual([]);
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it.each([
    ["undefined", undefined],
    ["NaN direct count", { liveScopesRevoked: Number.NaN }],
    ["incomplete directory counts", { sessionDirectoriesRemoved: 1 }],
  ])("keeps malformed %s live revoke results pending after attempting every phase", async (_label, result) => {
    const log = vi.fn();
    const mainRevoke = vi.fn(() => result);
    const sideRevoke = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    }));
    const routineRevoke = vi.fn(() => ({
      activeLoopsVisited: 0,
      liveScopesRevoked: 0,
    }));
    const subAgentRevoke = vi.fn(() => ({
      activeChildrenVisited: 0,
      liveScopesRevoked: 0,
    }));
    const pruneRoutineScopes = vi.fn(async () => ({
      routinesUpdated: 0,
      directoriesRemoved: 0,
    }));
    const prunePathGrants = vi.fn(async () => []);
    const detachSessionsFromProject = vi.fn(async () => 0);
    registerWorkspaceHandlers({
      auditLogger: { log },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject },
      conversationLoop: {
        deps: {},
        permissionManager: { prunePathGrantsUnderRoot: prunePathGrants },
        revokeWorkspaceRoot: mainRevoke,
      },
      sideChatConversationLoop: {
        deps: {},
        revokeWorkspaceRoot: sideRevoke,
      },
      routineEngine: { revokeWorkspaceRoot: routineRevoke },
      getSubAgentRunner: () => ({
        detachSessionsFromProject: vi.fn(async () => 0),
        revokeWorkspaceRoot: subAgentRevoke,
      }),
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never);

    try {
      const response = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };

      expect(response).toMatchObject({ ok: true, cleanupPending: true });
      expect(mainRevoke).toHaveBeenCalledTimes(1);
      expect(sideRevoke).toHaveBeenCalledTimes(1);
      expect(routineRevoke).toHaveBeenCalledTimes(1);
      expect(subAgentRevoke).toHaveBeenCalledTimes(1);
      expect(pruneRoutineScopes).toHaveBeenCalledTimes(1);
      expect(prunePathGrants).toHaveBeenCalledTimes(1);
      expect(detachSessionsFromProject).toHaveBeenCalledTimes(1);
      expect(completeWorkspaceRootRemovalPersistMock).not.toHaveBeenCalled();
      expect(pendingWorkspaceRootRemovals.value).toHaveLength(1);
      const warning = log.mock.calls
        .map(([entry]) => entry as { type?: string; input?: string })
        .find((entry) =>
          entry.type === "warn" &&
          entry.input?.includes("WORKSPACE_ROOT_LIVE_SCOPE_REVOKE_INVALID_RESULT")
        );
      expect(warning).toBeDefined();
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("serializes same-root removal side effects before a concurrent re-add", async () => {
    let signalPruneStarted!: () => void;
    let releasePruneGate!: () => void;
    let released = false;
    const pruneStarted = new Promise<void>((resolve) => {
      signalPruneStarted = resolve;
    });
    const pruneGate = new Promise<void>((resolve) => {
      releasePruneGate = resolve;
    });
    const releasePrune = () => {
      if (released) return;
      released = true;
      releasePruneGate();
    };
    let pruneCalls = 0;
    const pruneRoutineScopes = vi.fn(async () => {
      pruneCalls += 1;
      if (pruneCalls === 1) signalPruneStarted();
      await pruneGate;
      return { routinesUpdated: 0, directoriesRemoved: 0 };
    });
    const lifecycleDeps = {
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject: vi.fn(async () => 0) },
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: vi.fn(async () => []) },
      },
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never;
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [root] });
    registerWorkspaceHandlers(lifecycleDeps);

    try {
      const removePromise = invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root) as Promise<{
        ok: boolean;
        removed?: string;
      }>;
      await pruneStarted;

      const pickPromise = invoke(CHANNELS.workspace.pickRoot, OK_FRAME) as Promise<{
        ok: boolean;
        added?: string;
      }>;
      await vi.waitFor(() => expect(showOpenDialogMock).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();

      releasePrune();
      const [removed, picked] = await Promise.all([removePromise, pickPromise]);

      expect(removed).toMatchObject({ ok: true, removed: root });
      expect(picked).toMatchObject({ ok: true, added: canonicalizePathForMatch(root) });
      expect(beginWorkspaceRootRemovalPersistMock).toHaveBeenCalled();
      expect(completeWorkspaceRootRemovalPersistMock).toHaveBeenCalled();
      expect(addAllowedDirectoryPersistMock).toHaveBeenCalledWith(canonicalizePathForMatch(root));
      expect(completeWorkspaceRootRemovalPersistMock.mock.invocationCallOrder[0]).toBeLessThan(
        addAllowedDirectoryPersistMock.mock.invocationCallOrder[0]!,
      );
    } finally {
      releasePrune();
      registerWorkspaceHandlers(deps);
    }
  });

  it("keeps removal inactive and pending when durable routine scope prune fails", async () => {
    const log = vi.fn();
    const pruneError = Object.assign(new Error("must-not-leak-path"), { code: "EACCES" });
    const prunePathGrants = vi.fn(async () => []);
    const detachSessionsFromProject = vi.fn(async () => 0);
    const pruneRoutineScopes = vi.fn(async () => {
      throw pruneError;
    });
    const lifecycleDeps = {
      auditLogger: { log },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject },
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: prunePathGrants },
        revokeWorkspaceRoot: vi.fn(() => ({
          sessionDirectoriesRemoved: 0,
          turnDirectoriesRemoved: 0,
          projectRebound: false,
        })),
      },
      routinesStore: {
        revokeWorkspaceRoot: pruneRoutineScopes,
      },
    } as never;
    registerWorkspaceHandlers(lifecycleDeps);
    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };
      expect(res).toMatchObject({
        ok: true,
        cleanupPending: true,
      });
      expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(additionalDirectories.value).toEqual([]);
      expect(pendingWorkspaceRootRemovals.value).toHaveLength(1);
      expect(completeWorkspaceRootRemovalPersistMock).not.toHaveBeenCalled();
      expect(pruneRoutineScopes).toHaveBeenCalledTimes(1);
      expect(prunePathGrants).toHaveBeenCalledTimes(1);
      expect(detachSessionsFromProject).toHaveBeenCalledTimes(1);
      const warning = log.mock.calls
        .map(([entry]) => entry as { type?: string; input?: string })
        .find((entry) => entry.type === "warn" && entry.input?.includes("prune-routine-scopes"));
      expect(warning).toBeDefined();
      expect(JSON.parse(warning!.input!)).toMatchObject({
        lifecyclePhase: "prune-routine-scopes",
        errorCode: "EACCES",
      });
      expect(warning!.input).not.toContain("must-not-leak-path");
      expect(JSON.stringify(res)).not.toContain("must-not-leak-path");
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });
  it("revokes live scope and leaves cleanup pending when path-grant pruning fails", async () => {
    const log = vi.fn();
    const revokeWorkspaceRoot = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    }));
    const detachSessionsFromProject = vi.fn(async () => 0);
    const pruneError = Object.assign(new Error("must-not-leak-grant-path"), {
      code: "EIO",
    });
    const lifecycleDeps = {
      auditLogger: { log },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject },
      conversationLoop: {
        permissionManager: {
          prunePathGrantsUnderRoot: vi.fn(async () => {
            throw pruneError;
          }),
        },
        revokeWorkspaceRoot,
      },
      routinesStore: {
        revokeWorkspaceRoot: vi.fn(async () => ({
          routinesUpdated: 0,
          directoriesRemoved: 0,
        })),
      },
    } as never;
    registerWorkspaceHandlers(lifecycleDeps);

    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };
      expect(res).toMatchObject({
        ok: true,
        cleanupPending: true,
      });
      expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(additionalDirectories.value).toEqual([]);
      expect(pendingWorkspaceRootRemovals.value).toHaveLength(1);
      expect(revokeWorkspaceRoot).toHaveBeenCalled();
      expect(detachSessionsFromProject).toHaveBeenCalledTimes(1);
      const warning = log.mock.calls
        .map(([entry]) => entry as { type?: string; input?: string })
        .find((entry) => entry.type === "warn" && entry.input?.includes("prune-path-grants"));
      expect(warning).toBeDefined();
      expect(JSON.parse(warning!.input!)).toMatchObject({
        lifecyclePhase: "prune-path-grants",
        errorCode: "EIO",
      });
      expect(warning!.input).not.toContain("must-not-leak-grant-path");
      expect(JSON.stringify(res)).not.toContain("must-not-leak-grant-path");
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("keeps guards and pending intent when session metadata detach fails", async () => {
    const allowProjectRoot = vi.fn();
    const detachSessionsFromProject = vi.fn(async () => {
      throw Object.assign(new Error("must-not-leak-metadata-path"), { code: "EIO" });
    });
    const revokeWorkspaceRoot = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    }));
    const log = vi.fn();
    registerWorkspaceHandlers({
      auditLogger: { log },
      getMainWindow: () => null,
      memoryManager: { allowProjectRoot, detachSessionsFromProject },
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: vi.fn(async () => []) },
        revokeWorkspaceRoot,
      },
      routinesStore: {
        revokeWorkspaceRoot: vi.fn(async () => ({
          routinesUpdated: 0,
          directoriesRemoved: 0,
        })),
      },
    } as never);
    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };
      expect(res).toMatchObject({ ok: true, cleanupPending: true });
      expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(additionalDirectories.value).toEqual([]);
      expect(pendingWorkspaceRootRemovals.value).toHaveLength(1);
      expect(revokeWorkspaceRoot).toHaveBeenCalled();
      expect(allowProjectRoot).not.toHaveBeenCalled();
      expect(JSON.stringify(res)).not.toContain("must-not-leak-metadata-path");
      expect(JSON.stringify(log.mock.calls)).not.toContain("must-not-leak-metadata-path");
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });


  it("removeRoot REFUSES the default root (cwd) — it is not a removable addition", async () => {
    const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, process.cwd())) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "cannot-remove-default" });
    expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("removeRoot REFUSES a path that is not in the allow-list (no arbitrary removal)", async () => {
    const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, join(tmpdir(), "never-added-xyz"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "not-an-additional-root" });
    expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("removeRoot rejects an unauthorized sender frame (fail-closed)", async () => {
    const res = (await invoke(CHANNELS.workspace.removeRoot, EVIL_FRAME, root)) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
    expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("#1493 removeRoot prunes path grants under the root and reports the count", async () => {
    // Re-register the workspace handler with a deps carrying a stub permission
    // manager so the prune path fires. #1494 item-4: prunePathGrantsUnderRoot now
    // returns the pruned grant TUPLES (not a bare number); the handler derives
    // prunedGrants:3 (length) for the renderer toast AND audits redacted
    // per-pattern provenance.
    const prunedTuples = [
      { pattern: "write_file:path:/ws/a.md", toolName: "write_file", tier: "write" as const, path: "/ws/a.md" },
      { pattern: "edit_file:path:/ws/b.ts", toolName: "edit_file", tier: "write" as const, path: "/ws/b.ts" },
      { pattern: "delete_file:path:/ws/c.log", toolName: "delete_file", tier: "read" as const, path: "/ws/c.log" },
    ];
    const prune = vi.fn(async () => prunedTuples);
    const auditLog = vi.fn();
    const depsWithPm = {
      auditLogger: { log: auditLog },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject: vi.fn(async () => 0) },
      conversationLoop: { permissionManager: { prunePathGrantsUnderRoot: prune } },
      routinesStore: {
        revokeWorkspaceRoot: vi.fn(async () => ({ routinesUpdated: 0, directoriesRemoved: 0 })),
      },
    } as never;
    registerWorkspaceHandlers(depsWithPm);
    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        prunedGrants?: number;
      };
      // IPC response shape unchanged — a bare count, never the pattern list.
      expect(res).toMatchObject({ ok: true, prunedGrants: 3 });
      expect(prune).toHaveBeenCalledWith(canonicalizePathForMatch(root), {
        preserveRoots: [],
      });
      // The success audit records redacted per-pattern tuples (tool/tier/path).
      const infoEntry = auditLog.mock.calls
        .map((c) => c[0] as { type: string; input: string })
        .find((entry) => entry.type === "info" && entry.input.includes(CHANNELS.workspace.removeRoot));
      expect(infoEntry).toBeTruthy();
      const parsed = JSON.parse(infoEntry!.input) as {
        prunedGrants: number;
        prunedPatterns?: Array<{ tool: string; tier: string; path: string }>;
      };
      expect(parsed.prunedGrants).toBe(3);
      expect(parsed.prunedPatterns).toHaveLength(3);
      expect(parsed.prunedPatterns![0]).toMatchObject({ tool: "write_file", tier: "write" });
      // Raw pattern strings must NOT leak into the response (renderer unchanged).
      expect(JSON.stringify(res)).not.toContain("write_file:path:");
    } finally {
      // Restore the shared handler registration for later tests in this file.
      registerWorkspaceHandlers(deps);
    }
  });

  it("keeps removal pending when the permission manager is unavailable", async () => {
    registerWorkspaceHandlers({
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      routinesStore: {
        revokeWorkspaceRoot: vi.fn(async () => ({ routinesUpdated: 0, directoriesRemoved: 0 })),
      },
    } as never);
    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };
      expect(res).toMatchObject({ ok: true, cleanupPending: true });
      expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(additionalDirectories.value).toEqual([]);
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("keeps removal pending when the routines store is unavailable", async () => {
    registerWorkspaceHandlers({
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: vi.fn(async () => []) },
      },
    } as never);
    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };
      expect(res).toMatchObject({ ok: true, cleanupPending: true });
      expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(additionalDirectories.value).toEqual([]);
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("reveal shows a scope-checked file's location and never the raw renderer path", async () => {
    const res = (await invoke(CHANNELS.workspace.reveal, OK_FRAME, join(root, "docs", "architecture.md"))) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);
    expect(showItemInFolderMock).toHaveBeenCalledTimes(1);
    // The shell only ever receives the main-owned realpath from the scope guard.
    const [arg] = showItemInFolderMock.mock.calls[0] as [string];
    expect(arg.endsWith(join("docs", "architecture.md"))).toBe(true);
  });

  it("reveal reveals a directory too (guard allows dirs)", async () => {
    const res = (await invoke(CHANNELS.workspace.reveal, OK_FRAME, join(root, "docs"))) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(showItemInFolderMock).toHaveBeenCalledTimes(1);
  });

  it("reveal rejects a path outside the allowed roots (never touches the shell)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lvis-ws-reveal-outside-"));
    writeFileSync(join(outside, "secret.txt"), "nope");
    additionalDirectories.value = [];
    const res = (await invoke(CHANNELS.workspace.reveal, OK_FRAME, join(outside, "secret.txt"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "path-not-allowed" });
    expect(showItemInFolderMock).not.toHaveBeenCalled();
    rmSync(outside, { recursive: true, force: true });
  });

  it("reveal hard-blocks a Layer 0 sensitive path", async () => {
    const res = (await invoke(CHANNELS.workspace.reveal, OK_FRAME, join(homedir(), ".ssh", "id_rsa"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "sensitive-path" });
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  it("reveal rejects an unauthorized sender frame (fail-closed)", async () => {
    const res = (await invoke(CHANNELS.workspace.reveal, EVIL_FRAME, join(root, "docs"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });
});

describe("workspace:drop-prepare handler (#1458 drag-drop add-root)", () => {
  it("rejects an unauthorized sender frame (fail-closed)", async () => {
    const res = (await invoke(CHANNELS.workspace.dropPrepare, EVIL_FRAME, root)) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("rejects a non-string / empty path (invalid-path)", async () => {
    const res = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, "")) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "invalid-path" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("mints a MAIN-OWNED ack token for a valid dropped folder and NEVER persists directly", async () => {
    // A drop always requires acknowledgement (even with zero warnings): the OS
    // dialog never vouched for the path, so the explicit user ack is that vouch.
    const dropped = mkdtempSync(join(tmpdir(), "lvis-ws-drop-"));
    const res = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, dropped)) as {
      ok: boolean;
      pendingPath?: string;
      ackToken?: string;
      added?: string;
    };
    expect(res.ok).toBe(true);
    expect(res.pendingPath).toBe(dropped);
    expect(typeof res.ackToken).toBe("string");
    expect((res.ackToken ?? "").length).toBeGreaterThan(0);
    // dropPrepare NEVER widens the read scope on its own — persistence only
    // happens on the pickRoot ack pass. (added is not returned by dropPrepare.)
    expect((res as { added?: string }).added).toBeUndefined();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
    rmSync(dropped, { recursive: true, force: true });
  });

  it("HARD-DENIES a Layer 0 sensitive dropped path and mints NO token", async () => {
    // A renderer that resolves a dropped ~/.ssh cannot widen the read scope: the
    // deny happens before any token is minted, so it can never be acknowledged.
    // The surfaced error is the STABLE `sensitive-path` code (mapped to Korean in
    // the renderer), NEVER the validator's raw English prose.
    const res = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, join(homedir(), ".ssh"))) as {
      ok: boolean;
      error?: string;
      ackToken?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "sensitive-path" });
    expect(res.ackToken).toBeUndefined();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("REFUSES the filesystem root (hard deny, no token)", async () => {
    // Surfaces the stable `path-not-allowed` code, not raw English prose.
    const fsRoot = process.platform === "win32" ? "C:\\" : "/";
    const res = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, fsRoot)) as {
      ok: boolean;
      error?: string;
      ackToken?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "path-not-allowed" });
    expect(res.ackToken).toBeUndefined();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("rejects a dropped FILE (not-a-dir — the renderer never guesses a parent)", async () => {
    const base = mkdtempSync(join(tmpdir(), "lvis-ws-dropfile-"));
    const file = join(base, "note.txt");
    writeFileSync(file, "hi");
    const res = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, file)) as {
      ok: boolean;
      error?: string;
      ackToken?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "not-a-dir" });
    expect(res.ackToken).toBeUndefined();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
    rmSync(base, { recursive: true, force: true });
  });

  it("rejects a non-existent dropped path (not-found)", async () => {
    const res = (await invoke(
      CHANNELS.workspace.dropPrepare,
      OK_FRAME,
      join(tmpdir(), "lvis-ws-does-not-exist-xyz"),
    )) as { ok: boolean; error?: string; ackToken?: string };
    expect(res).toMatchObject({ ok: false, error: "not-found" });
    expect(res.ackToken).toBeUndefined();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("drop → dropPrepare → pickRoot(token) persists the folder and audits gesture=drop", async () => {
    const log = (deps as unknown as { auditLogger: { log: ReturnType<typeof vi.fn> } }).auditLogger.log;
    const dropped = mkdtempSync(join(tmpdir(), "lvis-ws-drop-flow-"));
    const prep = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, dropped)) as {
      ok: boolean;
      ackToken?: string;
    };
    expect(prep.ok).toBe(true);
    log.mockClear();
    addAllowedDirectoryPersistMock.mockClear();
    // The renderer confirms by echoing the TOKEN (never re-supplying the path).
    const done = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: prep.ackToken })) as {
      ok: boolean;
      added?: string;
    };
    expect(done).toMatchObject({ ok: true, added: canonicalizePathForMatch(dropped) });
    expect(addAllowedDirectoryPersistMock).toHaveBeenCalledWith(canonicalizePathForMatch(dropped));
    // The widening audit records gesture=drop so a renderer-named drop widening
    // is distinguishable from a native-picker widening.
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        input: expect.stringContaining('"gesture":"drop"'),
      }),
    );
    rmSync(dropped, { recursive: true, force: true });
  });

  it("a drop ack token is ONE-TIME — a replay is refused after first use", async () => {
    const dropped = mkdtempSync(join(tmpdir(), "lvis-ws-drop-replay-"));
    const prep = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, dropped)) as { ackToken?: string };
    const token = prep.ackToken;
    const first = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: token })) as {
      ok: boolean;
      added?: string;
    };
    expect(first).toMatchObject({ ok: true, added: canonicalizePathForMatch(dropped) });
    addAllowedDirectoryPersistMock.mockClear();
    const replay = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: token })) as {
      ok: boolean;
      error?: string;
    };
    expect(replay).toMatchObject({ ok: false, error: "ack-unknown" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
    rmSync(dropped, { recursive: true, force: true });
  });

  it("re-checks is-a-directory at the ack pass — a dir swapped for a file after prepare is refused (TOCTOU)", async () => {
    // prepare a real directory, mint a token, THEN replace the directory with a
    // regular file before the ack lands. The persist pass must re-stat and refuse
    // a non-directory rather than widening the read scope to a file.
    const base = mkdtempSync(join(tmpdir(), "lvis-ws-drop-toctou-"));
    const target = join(base, "target");
    mkdirSync(target);
    const prep = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, target)) as {
      ok: boolean;
      ackToken?: string;
    };
    expect(prep.ok).toBe(true);
    expect(typeof prep.ackToken).toBe("string");
    // Swap the directory for a file between prepare and ack.
    rmSync(target, { recursive: true, force: true });
    writeFileSync(target, "now a file");
    addAllowedDirectoryPersistMock.mockClear();
    const done = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: prep.ackToken })) as {
      ok: boolean;
      error?: string;
    };
    expect(done).toMatchObject({ ok: false, error: "not-a-dir" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
    rmSync(base, { recursive: true, force: true });
  });

  it("re-checks existence at the ack pass — a path deleted after prepare is refused (not-found)", async () => {
    // A directory removed entirely between prepare and ack must fail closed at
    // persist rather than persisting a vanished path into the read allow-list.
    const dropped = mkdtempSync(join(tmpdir(), "lvis-ws-drop-vanish-"));
    const prep = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, dropped)) as {
      ok: boolean;
      ackToken?: string;
    };
    expect(prep.ok).toBe(true);
    rmSync(dropped, { recursive: true, force: true });
    addAllowedDirectoryPersistMock.mockClear();
    const done = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: prep.ackToken })) as {
      ok: boolean;
      error?: string;
    };
    expect(done).toMatchObject({ ok: false, error: "not-found" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });
});
