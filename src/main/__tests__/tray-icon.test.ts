import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { createLvisTrayIcon, resolveTrayIconPath } from "../tray-icon.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..", "..");
const moduleDir = join(root, "src", "main");

describe("LVIS tray icon", () => {
  it("resolves macOS to the template PNG asset", () => {
    expect(
      resolveTrayIconPath({
        platform: "darwin",
        resourcesPath: "/missing/resources",
        cwd: root,
        moduleDir,
      }),
    ).toBe(join(root, "build", "tray-iconTemplate.png"));
  });

  it("resolves Windows to the white PNG asset", () => {
    expect(
      resolveTrayIconPath({
        platform: "win32",
        resourcesPath: "/missing/resources",
        cwd: root,
        moduleDir,
      }),
    ).toBe(join(root, "build", "tray-icon.png"));
  });

  it("fails loudly when the packaged tray icon asset is missing", () => {
    expect(() =>
      resolveTrayIconPath({
        platform: "darwin",
        resourcesPath: "/missing/resources",
        cwd: "/missing/cwd",
        moduleDir: "/missing/module",
        exists: () => false,
      }),
    ).toThrow(/tray icon asset missing/);
  });

  it("marks only the macOS tray image as a template image", () => {
    const macIcon = {
      isEmpty: () => false,
      setTemplateImage: vi.fn(),
    };
    const winIcon = {
      isEmpty: () => false,
      setTemplateImage: vi.fn(),
    };
    const nativeImage = {
      createFromPath: vi.fn()
        .mockReturnValueOnce(macIcon)
        .mockReturnValueOnce(winIcon),
    };

    createLvisTrayIcon({
      nativeImage: nativeImage as never,
      platform: "darwin",
      resourcesPath: "/missing/resources",
      cwd: root,
      moduleDir,
    });
    createLvisTrayIcon({
      nativeImage: nativeImage as never,
      platform: "win32",
      resourcesPath: "/missing/resources",
      cwd: root,
      moduleDir,
    });

    expect(macIcon.setTemplateImage).toHaveBeenCalledWith(true);
    expect(winIcon.setTemplateImage).not.toHaveBeenCalled();
    expect(nativeImage.createFromPath).toHaveBeenNthCalledWith(1, join(root, "build", "tray-iconTemplate.png"));
    expect(nativeImage.createFromPath).toHaveBeenNthCalledWith(2, join(root, "build", "tray-icon.png"));
  });
});
