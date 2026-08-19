import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..", "..");

function readPackageJson(): {
  build: {
    icon: string;
    extraResources: Array<{ from: string; to: string }>;
    dmg: { contents: Array<{ path?: string; type?: string; x?: number; y?: number }> };
    linux: Record<string, unknown>;
    nsis: Record<string, unknown>;
  };
} {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

/**
 * The app icon directories the freedesktop hicolor theme declares in its
 * `index.theme`. Icon-theme lookup walks only declared directories, so a size
 * outside this set installs to a path no desktop environment ever searches.
 */
const HICOLOR_APP_SIZES = new Set([16, 22, 24, 32, 36, 48, 64, 72, 96, 128, 192, 256, 512]);

/** Pixel dimensions from a PNG's IHDR, which is always its first chunk. */
function readPngSize(filePath: string): { width: number; height: number } {
  const png = readFileSync(filePath);
  expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Frame widths declared by an `.ico` directory, where a stored 0 means 256. */
function readIcoFrameWidths(filePath: string): number[] {
  const ico = readFileSync(filePath);
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  const count = ico.readUInt16LE(4);
  return Array.from({ length: count }, (_unused, index) => ico[6 + index * 16] || 256);
}

describe("desktop packaging", () => {
  it("packages tray icon PNG assets next to Electron resources", () => {
    const pkg = readPackageJson();
    expect(pkg.build.extraResources).toEqual(
      expect.arrayContaining([
        { from: "build/tray-icon.png", to: "tray-icon.png" },
        { from: "build/tray-icon@2x.png", to: "tray-icon@2x.png" },
        { from: "build/tray-iconTemplate.png", to: "tray-iconTemplate.png" },
        {
          from: "build/tray-iconTemplate@2x.png",
          to: "tray-iconTemplate@2x.png",
        },
      ]),
    );
  });

  it("packages compressed uv runtime and its license notice as Electron resources", () => {
    const pkg = readPackageJson();
    expect(pkg.build.extraResources).toEqual(
      expect.arrayContaining([
        { from: "resources/uv-runtime", to: "uv" },
        { from: "resources/licenses/uv", to: "licenses/uv" },
      ]),
    );

    const uvLicense = readFileSync(
      join(root, "resources", "licenses", "uv", "LICENSE-MIT"),
      "utf8",
    );
    expect(uvLicense).toContain(
      "MIT License Copyright (c) 2025 Astral Software Inc.",
    );
    expect(uvLicense).toContain("permission notice shall be included");
  });

  it("packages runtime guidance with its safe replacement hash inventory", () => {
    const pkg = readPackageJson();
    expect(pkg.build.extraResources).toEqual(
      expect.arrayContaining([
        { from: "resources/AGENTS.md", to: "AGENTS.md" },
        {
          from: "resources/AGENTS.md.replaceable-sha256",
          to: "AGENTS.md.replaceable-sha256",
        },
      ]),
    );
  });

  it("ships only the app and Applications link in the public DMG", () => {
    const pkg = readPackageJson();
    expect(pkg.build.dmg.contents).toEqual([
      { type: "file", x: 140, y: 130 },
      { path: "/Applications", type: "link", x: 400, y: 130 },
    ]);
  });

  it("keeps the macOS uninstaller on fixed LVIS data paths", () => {
    const script = readFileSync(
      join(root, "build", "dmg-extras", "uninstall.command"),
      "utf8",
    );
    expect(script).toContain('LVIS_HOME="$HOME/.lvis"');
    expect(script).not.toContain("${LVIS_HOME:-");
    expect(script).not.toContain("LVIS_HOME:-");
  });

  it("removes user data on Windows uninstall (Roaming + ~/.lvis cleanup wired)", () => {
    const pkg = readPackageJson();
    expect(pkg.build.nsis).toMatchObject({
      oneClick: true,
      createStartMenuShortcut: true,
      uninstallDisplayName: "LVIS",
      // The custom hook owns every user-data path so `/KEEP_APP_DATA` can
      // preserve Roaming data as well as LVIS_HOME and Local AppData.
      deleteAppDataOnUninstall: false,
      include: "build/installer.nsh",
    });
  });

  it("keeps KEEP_APP_DATA ahead of current-user Windows data deletion", () => {
    const script = readFileSync(join(root, "build", "installer.nsh"), "utf8");
    const keepBranch = script.indexOf('${if} $R1 == "1"');
    const currentContext = script.indexOf("SetShellVarContext current");
    const roamingDelete = script.indexOf(
      'RMDir /r "$APPDATA\\${APP_FILENAME}"',
    );
    const restoreContext = script.indexOf(
      "SetShellVarContext all",
      currentContext,
    );

    expect(keepBranch).toBeGreaterThanOrEqual(0);
    expect(currentContext).toBeGreaterThan(keepBranch);
    expect(roamingDelete).toBeGreaterThan(currentContext);
    expect(restoreContext).toBeGreaterThan(roamingDelete);
    expect(script).toContain('RMDir /r "$APPDATA\\${APP_PRODUCT_FILENAME}"');
    expect(script).toContain('RMDir /r "$APPDATA\\${APP_PACKAGE_NAME}"');
    expect(script).toContain('RMDir /r "$LOCALAPPDATA\\${APP_FILENAME}"');
    expect(script).toContain(
      'RMDir /r "$LOCALAPPDATA\\${APP_PRODUCT_FILENAME}"',
    );
    expect(script).toContain('RMDir /r "$LOCALAPPDATA\\${APP_PACKAGE_NAME}"');
  });

  it("uses LVIS-branded icon assets for the one-click Windows installer", () => {
    const pkg = readPackageJson();
    expect(pkg.build.nsis).toMatchObject({
      oneClick: true,
      installerIcon: "build/installerIcon.ico",
      installerHeaderIcon: "build/installerHeaderIcon.ico",
    });

    for (const asset of ["installerIcon.ico", "installerHeaderIcon.ico"]) {
      const widths = readIcoFrameWidths(join(root, "build", asset));
      expect(widths.length).toBeGreaterThanOrEqual(5);
      // Multi-resolution, not one frame repeated: Windows picks per surface.
      expect(new Set(widths).size).toBe(widths.length);
      expect(widths).toContain(16);
      expect(widths).toContain(32);
      expect(widths).toContain(256);
    }
  });

  // Windows and macOS carry no `win.icon`/`mac.icon` of their own; both inherit
  // the top-level `build.icon` and electron-builder converts it to the `.ico`
  // the executable's resources need and the `.icns` the bundle needs. When that
  // source goes missing electron-builder does not fail the build — it logs a
  // warning and silently substitutes the stock Electron icon, so a release
  // ships unbranded. This is the assertion that turns that into a red suite.
  it("keeps the shared executable icon source on disk and large enough to convert", () => {
    const pkg = readPackageJson();
    expect(pkg.build.icon).toBe("build/icon.png");

    const iconPath = join(root, pkg.build.icon);
    expect(existsSync(iconPath)).toBe(true);

    const { width, height } = readPngSize(iconPath);
    expect(width).toBe(height);
    // 512 is the largest frame either ladder asks for; below it the converter
    // would have to upscale and the top of the ladder degrades.
    expect(width).toBeGreaterThanOrEqual(512);
  });

  // Linux launchers resolve the `.desktop` file's `Icon=` name through the
  // freedesktop icon theme, which searches only the sizes hicolor declares.
  // Pointing `linux.icon` at a lone master PNG installs one file at that
  // master's size — 1024x1024, a directory hicolor does not declare — and the
  // launcher shows a generic icon because the lookup never walks that path.
  // The icon set below is what makes `Icon=` resolvable at all.
  it("ships a Linux icon set at sizes the hicolor theme actually searches", () => {
    const pkg = readPackageJson();
    expect(pkg.build.linux.icon).toBe("build/icons");

    const iconSetDir = join(root, pkg.build.linux.icon as string);
    expect(statSync(iconSetDir).isDirectory()).toBe(true);

    const files = readdirSync(iconSetDir).sort();
    expect(files.length).toBeGreaterThan(0);

    const sizes = files.map((file) => {
      // electron-builder reads the pixel size out of the filename when it
      // walks an icon-set directory, so a name that disagrees with the image
      // installs the wrong bytes under the right size.
      const named = /^(\d+)x(\d+)\.png$/.exec(file);
      expect(named, `${file} must be named <size>x<size>.png`).not.toBeNull();
      const size = Number(named?.[1]);
      expect(Number(named?.[2])).toBe(size);

      const { width, height } = readPngSize(join(iconSetDir, file));
      expect(width, `${file} pixel width must match its name`).toBe(size);
      expect(height, `${file} pixel height must match its name`).toBe(size);

      expect(HICOLOR_APP_SIZES.has(size), `${size}x${size} is not a hicolor app size`).toBe(true);
      return size;
    });

    // The sizes desktop environments reach for most: the launcher grid (48),
    // the window list (16/24/32) and HiDPI surfaces (128/256/512).
    for (const required of [16, 24, 32, 48, 64, 128, 256, 512]) {
      expect(sizes, `icon set is missing ${required}x${required}`).toContain(required);
    }
  });

  it("verifies Windows app-file removal and exposes retry/failure paths", () => {
    const script = readFileSync(join(root, "build", "installer.nsh"), "utf8");

    expect(script).toContain("!macro customRemoveFiles");
    expect(script).toContain('RMDir /r "$INSTDIR"');
    expect(script).toContain('"$INSTDIR\\${APP_EXECUTABLE_FILENAME}"');
    expect(script).toContain(
      'ExecShell "runas" "$EXEPATH" "$R0 /KEEP_APP_DATA /LVIS_ELEVATED_RETRY"',
    );
    expect(script).toContain("SetErrorLevel 1");
    expect(script).toContain("LVIS uninstall failed: app files remain");
  });
});
