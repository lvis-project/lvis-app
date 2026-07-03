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

  it("addRootByPath NEVER persists immediately — a dropped dir always requires ack", async () => {
    const dropped = mkdtempSync(join(tmpdir(), "lvis-ws-drop-"));
    const res = (await invoke(CHANNELS.workspace.addRootByPath, OK_FRAME, dropped)) as {
      ok: boolean;
      requiresAcknowledgement?: boolean;
      pendingPath?: string;
      ackToken?: string;
      added?: string;
    };
    expect(res.ok).toBe(true);
    expect(res.requiresAcknowledgement).toBe(true);
    expect(res.pendingPath).toBe(dropped);
    expect(typeof res.ackToken).toBe("string");
    expect((res.ackToken ?? "").length).toBeGreaterThan(0);
    // Crucially: the drop path is NOT persisted without the second ack pass.
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();

    // The existing pickRoot ack path performs the (re-validated) persist.
    const confirmed = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: res.ackToken })) as {
      ok: boolean;
      added?: string;
    };
    expect(confirmed).toMatchObject({ ok: true, added: dropped });
    expect(addAllowedDirectoryPersistMock).toHaveBeenCalledWith(dropped);
    rmSync(dropped, { recursive: true, force: true });
  });

  it("addRootByPath rejects a dropped FILE (not a project root; no dirname guessing)", async () => {
    const res = (await invoke(CHANNELS.workspace.addRootByPath, OK_FRAME, join(root, "bin.dat"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "not-a-dir" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("addRootByPath hard-refuses a Layer 0 / root path even before ack", async () => {
    const res = (await invoke(CHANNELS.workspace.addRootByPath, OK_FRAME, homedir() + "/.ssh")) as {
      ok: boolean;
      error?: string;
    };
    // Either not-a-dir (no .ssh dir) or a sensitive/root refusal — never ok.
    expect(res.ok).toBe(false);
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("addRootByPath rejects an unauthorized sender frame (fail-closed)", async () => {
    const res = (await invoke(CHANNELS.workspace.addRootByPath, EVIL_FRAME, root)) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });
});
