import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { createLvisTrayIcon, resolveTrayIconPath } from "../tray-icon.js";
import { resolveRuntimePathsFromModuleUrl } from "../main-paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..", "..");

describe("LVIS tray icon", () => {
  it("resolves macOS to the template PNG asset", () => {
    expect(
      resolveTrayIconPath({
        platform: "darwin",
        resourcesPath: "/missing/resources",
        cwd: root,
        projectRoot: root,
      }),
    ).toBe(join(root, "build", "tray-iconTemplate.png"));
  });

  it("resolves Windows to the white PNG asset", () => {
    expect(
      resolveTrayIconPath({
        platform: "win32",
        resourcesPath: "/missing/resources",
        cwd: root,
        projectRoot: root,
      }),
    ).toBe(join(root, "build", "tray-icon.png"));
  });

  it("fails loudly when the packaged tray icon asset is missing", () => {
    expect(() =>
      resolveTrayIconPath({
        platform: "darwin",
        resourcesPath: "/missing/resources",
        cwd: "/missing/cwd",
        projectRoot: "/missing/project",
        exists: () => false,
      }),
    ).toThrow(/tray icon asset missing/);
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "resolves a split main bundle after workspace chdir on %s",
    (platform) => {
      const fileName = platform === "darwin" ? "tray-iconTemplate.png" : "tray-icon.png";
      const expected = join(root, "build", fileName);
      const paths = new Set([
        join(root, "dist", "src", "main", "main.js"),
        join(root, "dist", "src", "preload.cjs"),
        expected,
      ]);
      const exists = (path: string) => paths.has(path);
      const runtime = resolveRuntimePathsFromModuleUrl(
        pathToFileURL(join(root, "dist", "src", "main", "chunks", "shared.js")).href,
        exists,
      );
      expect(resolveTrayIconPath({
        platform,
        resourcesPath: "/missing/resources",
        cwd: "/workspace/unrelated",
        projectRoot: runtime.projectRoot,
        exists,
      })).toBe(expected);
    },
  );

  it("prefers packaged resources over a development or workspace icon", () => {
    const resourcesPath = join(root, "packaged-resources");
    expect(resolveTrayIconPath({
      platform: "linux",
      resourcesPath,
      projectRoot: root,
      cwd: root,
      exists: () => true,
    })).toBe(join(resourcesPath, "tray-icon.png"));
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
      projectRoot: root,
    });
    createLvisTrayIcon({
      nativeImage: nativeImage as never,
      platform: "win32",
      resourcesPath: "/missing/resources",
      cwd: root,
      projectRoot: root,
    });

    expect(macIcon.setTemplateImage).toHaveBeenCalledWith(true);
    expect(winIcon.setTemplateImage).not.toHaveBeenCalled();
    expect(nativeImage.createFromPath).toHaveBeenNthCalledWith(1, join(root, "build", "tray-iconTemplate.png"));
    expect(nativeImage.createFromPath).toHaveBeenNthCalledWith(2, join(root, "build", "tray-icon.png"));
  });
});
