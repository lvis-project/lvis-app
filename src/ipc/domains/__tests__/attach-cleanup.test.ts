import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeAppIpcHandler } from "./test-helpers.js";

const { handlers, showOpenDialogMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialogMock: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: { showOpenDialog: showOpenDialogMock },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
  nativeImage: {
    createFromBuffer: vi.fn(() => ({ getSize: () => ({ width: 1, height: 1 }) })),
  },
  shell: { openPath: vi.fn(async () => "") },
}));

import { CHANNELS } from "../../../contract/app-contract.js";
import { registerAttachHandlers } from "../attach.js";

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
const invoke = (channel: string, ...args: unknown[]) => invokeAppIpcHandler(handlers, channel, ...args);
function invokeWithSenderFrame(
  channel: string,
  url: string,
  ...args: unknown[]
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(handler({ senderFrame: { url } } as never, ...args));
}

const savedPaths = new Set<string>();
let root: string;

async function saveOwnedClipboardImage(): Promise<string> {
  const result = await invoke(CHANNELS.attach.saveClipboardImage, { base64: PNG_BASE64 }) as {
    ok: boolean;
    path?: string;
  };
  expect(result).toMatchObject({ ok: true });
  expect(result.path).toEqual(expect.any(String));
  savedPaths.add(result.path!);
  return result.path!;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lvis-attach-cleanup-"));
  registerAttachHandlers({
    auditLogger: { log: vi.fn() },
    getMainWindow: () => ({}),
  } as never);
});

beforeEach(() => {
  showOpenDialogMock.mockReset();
});

afterAll(() => {
  for (const filePath of savedPaths) rmSync(filePath, { force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("lvis:attach:discardClipboardImage", () => {
  it("revokes an app-owned rejected clipboard file without pathname deletion", async () => {
    const filePath = await saveOwnedClipboardImage();
    expect(existsSync(filePath)).toBe(true);

    expect(await invoke(CHANNELS.attach.discardClipboardImage, filePath)).toEqual({ ok: true, retained: true });
    expect(existsSync(filePath)).toBe(true);
    expect(await invoke(CHANNELS.attach.readImage, filePath)).toEqual({
      ok: false,
      error: "path_not_authorized",
    });
    expect(await invoke(CHANNELS.attach.discardClipboardImage, filePath)).toEqual({
      ok: false,
      error: "clipboard-image-not-owned",
    });
  });

  it("keeps a replacement at an app-owned clipboard path while revoking its capability", async () => {
    const filePath = await saveOwnedClipboardImage();
    const priorOwnedPath = `${filePath}.original`;
    renameSync(filePath, priorOwnedPath);
    writeFileSync(filePath, Buffer.from("user-managed replacement file"));

    expect(await invoke(CHANNELS.attach.discardClipboardImage, filePath)).toEqual({
      ok: true,
      retained: true,
    });
    expect(existsSync(filePath)).toBe(true);

    rmSync(filePath, { force: true });
    rmSync(priorOwnedPath, { force: true });
  });

  it("never treats a user-picked file as a disposable clipboard file", async () => {
    const userFilePath = join(root, "user-picked.png");
    writeFileSync(userFilePath, Buffer.from(PNG_BASE64, "base64"));
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [userFilePath] });

    expect(await invoke(CHANNELS.attach.openFile)).toMatchObject({
      canceled: false,
      files: [{ path: userFilePath }],
    });
    expect(await invoke(CHANNELS.attach.discardClipboardImage, userFilePath)).toEqual({
      ok: false,
      error: "clipboard-image-not-owned",
    });
    expect(existsSync(userFilePath)).toBe(true);
    expect(await invoke(CHANNELS.attach.readImage, userFilePath)).toMatchObject({ ok: true });
  });

  it("accepts only a host renderer frame for capability revocation", async () => {
    const hostFilePath = await saveOwnedClipboardImage();
    expect(await invokeWithSenderFrame(
      CHANNELS.attach.discardClipboardImage,
      "file:///app/index.html",
      hostFilePath,
    )).toEqual({ ok: true, retained: true });

    const pluginFilePath = await saveOwnedClipboardImage();
    expect(await invokeWithSenderFrame(
      CHANNELS.attach.discardClipboardImage,
      "file:///app/plugin-ui-shell.html",
      pluginFilePath,
    )).toEqual({ ok: false, error: "unauthorized" });
    expect(await invoke(CHANNELS.attach.readImage, pluginFilePath)).toMatchObject({ ok: true });

    const remoteFilePath = await saveOwnedClipboardImage();
    expect(await invokeWithSenderFrame(
      CHANNELS.attach.discardClipboardImage,
      "https://untrusted.example/settings",
      remoteFilePath,
    )).toEqual({ ok: false, error: "unauthorized" });
    expect(await invoke(CHANNELS.attach.readImage, remoteFilePath)).toMatchObject({ ok: true });
  });
});

describe("lvis:attach image MIME normalization", () => {
  it("uses magic-derived MIME for renamed and extensionless picker images", async () => {
    const renamed = join(root, "png-content.jpg");
    const extensionless = join(root, "png-content");
    const png = Buffer.from(PNG_BASE64, "base64");
    writeFileSync(renamed, png);
    writeFileSync(extensionless, png);
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [renamed, extensionless] });

    expect(await invoke(CHANNELS.attach.openFile)).toMatchObject({
      canceled: false,
      files: [
        { path: renamed, ext: "jpg", isImage: true, mimeType: "image/png" },
        { path: extensionless, ext: "", isImage: true, mimeType: "image/png" },
      ],
    });

    for (const filePath of [renamed, extensionless]) {
      expect(await invoke(CHANNELS.attach.readImage, filePath)).toMatchObject({
        ok: true,
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${PNG_BASE64}`,
      });
    }
  });

  it("canonicalizes permissive clipboard base64 and rejects nonimages", async () => {
    const result = await invoke(CHANNELS.attach.saveClipboardImage, {
      base64: `${PNG_BASE64}\n`,
    }) as { ok: boolean; path?: string; mimeType?: string; dataUrl?: string };

    expect(result).toMatchObject({
      ok: true,
      mimeType: "image/png",
      dataUrl: `data:image/png;base64,${PNG_BASE64}`,
    });
    expect(result.path).toEqual(expect.any(String));
    savedPaths.add(result.path!);

    expect(await invoke(CHANNELS.attach.saveClipboardImage, {
      base64: Buffer.from("not an image").toString("base64"),
    })).toEqual({
      ok: false,
      error: "not_image",
    });
  });
});
