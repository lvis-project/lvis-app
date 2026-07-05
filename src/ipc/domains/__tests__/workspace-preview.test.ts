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
  additionalDirectories,
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialogMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
  addAllowedDirectoryPersistMock: vi.fn(async () => [] as string[]),
  removeAllowedDirectoryPersistMock: vi.fn(async (dir: string) => {
    additionalDirectories.value = additionalDirectories.value.filter((d) => d !== dir);
    return additionalDirectories.value;
  }),
  additionalDirectories: { value: [] as string[] },
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
    permissions: { additionalDirectories: additionalDirectories.value },
  }),
  addAllowedDirectoryPersist: addAllowedDirectoryPersistMock,
  removeAllowedDirectoryPersist: removeAllowedDirectoryPersistMock,
}));

import { registerPreviewHandlers } from "../preview.js";
import { registerWorkspaceHandlers } from "../workspace.js";
import { CHANNELS } from "../../../contract/app-contract.js";

const deps = {
  auditLogger: { log: vi.fn() },
  getMainWindow: () => null,
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
  additionalDirectories.value = [root];
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
    expect(res).toMatchObject({ ok: true, added: picked });
    expect(addAllowedDirectoryPersistMock).toHaveBeenCalledWith(picked);
    rmSync(picked, { recursive: true, force: true });
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
    expect(second).toMatchObject({ ok: true, added: warnDir });
    expect(showOpenDialogMock).not.toHaveBeenCalled();
    expect(addAllowedDirectoryPersistMock).toHaveBeenCalledWith(warnDir);

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
    expect(ok).toMatchObject({ ok: true, added: warnDir });

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
    expect(res).toMatchObject({ ok: true, added: picked });
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
    expect(removeAllowedDirectoryPersistMock).toHaveBeenCalledWith(root);
    expect(res.roots?.some((r) => r.path === root)).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        input: expect.stringContaining(CHANNELS.workspace.removeRoot),
      }),
    );
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
    // manager so the prune path fires. prunePathGrantsUnderRoot returns 3 →
    // handler surfaces prunedGrants:3 for the renderer toast.
    const prune = vi.fn(async () => 3);
    const depsWithPm = {
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      conversationLoop: { permissionManager: { prunePathGrantsUnderRoot: prune } },
    } as never;
    registerWorkspaceHandlers(depsWithPm);
    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        prunedGrants?: number;
      };
      expect(res).toMatchObject({ ok: true, prunedGrants: 3 });
      expect(prune).toHaveBeenCalledWith(root);
    } finally {
      // Restore the shared handler registration for later tests in this file.
      registerWorkspaceHandlers(deps);
    }
  });

  it("#1493 removeRoot still succeeds when no permission manager is wired (best-effort prune)", async () => {
    // The shared `deps` has no conversationLoop → prune is skipped, prunedGrants:0.
    const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
      ok: boolean;
      removed?: string;
      prunedGrants?: number;
    };
    expect(res).toMatchObject({ ok: true, removed: root, prunedGrants: 0 });
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
    expect(done).toMatchObject({ ok: true, added: dropped });
    expect(addAllowedDirectoryPersistMock).toHaveBeenCalledWith(dropped);
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
    expect(first).toMatchObject({ ok: true, added: dropped });
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
