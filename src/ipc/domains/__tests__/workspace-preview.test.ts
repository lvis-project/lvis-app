import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const { handlers, showOpenDialogMock, addAllowedDirectoryPersistMock, additionalDirectories } =
  vi.hoisted(() => ({
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    showOpenDialogMock: vi.fn(),
    addAllowedDirectoryPersistMock: vi.fn(async () => [] as string[]),
    additionalDirectories: { value: [] as string[] },
  }));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: { showOpenDialog: showOpenDialogMock },
}));

vi.mock("../../../permissions/permission-settings-store.js", () => ({
  readPermissionSettings: () => ({
    permissions: { additionalDirectories: additionalDirectories.value },
  }),
  addAllowedDirectoryPersist: addAllowedDirectoryPersistMock,
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
  addAllowedDirectoryPersistMock.mockClear();
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
});
