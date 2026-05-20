import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..", "..");

function readPackageJson(): {
  build: {
    extraResources: Array<{ from: string; to: string }>;
    dmg: { contents: Array<{ path?: string }> };
    nsis: Record<string, unknown>;
  };
} {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function readBmpInfo(relativePath: string): { width: number; height: number; bitsPerPixel: number } {
  const data = readFileSync(join(root, relativePath));
  expect(data.toString("ascii", 0, 2)).toBe("BM");
  return {
    width: data.readInt32LE(18),
    height: data.readInt32LE(22),
    bitsPerPixel: data.readUInt16LE(28),
  };
}

describe("desktop packaging", () => {
  it("packages tray icon PNG assets next to Electron resources", () => {
    const pkg = readPackageJson();
    expect(pkg.build.extraResources).toEqual(
      expect.arrayContaining([
        { from: "build/tray-icon.png", to: "tray-icon.png" },
        { from: "build/tray-icon@2x.png", to: "tray-icon@2x.png" },
        { from: "build/tray-iconTemplate.png", to: "tray-iconTemplate.png" },
        { from: "build/tray-iconTemplate@2x.png", to: "tray-iconTemplate@2x.png" },
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

    const uvLicense = readFileSync(join(root, "resources", "licenses", "uv", "LICENSE-MIT"), "utf8");
    expect(uvLicense).toContain("MIT License Copyright (c) 2025 Astral Software Inc.");
    expect(uvLicense).toContain("permission notice shall be included");
  });

  it("ships a macOS uninstall helper in the DMG extras", () => {
    const pkg = readPackageJson();
    expect(pkg.build.dmg.contents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "build/dmg-extras/uninstall.command" }),
      ]),
    );
    expect(statSync(join(root, "build", "dmg-extras", "uninstall.command")).mode & 0o111).not.toBe(0);
  });

  it("keeps the macOS uninstaller on fixed LVIS data paths", () => {
    const script = readFileSync(join(root, "build", "dmg-extras", "uninstall.command"), "utf8");
    expect(script).toContain('LVIS_HOME="$HOME/.lvis"');
    expect(script).not.toContain("${LVIS_HOME:-");
    expect(script).not.toContain("LVIS_HOME:-");
  });

  it("uses the branded assisted Windows installer with install path + LVIS_HOME selection", () => {
    const pkg = readPackageJson();
    expect(pkg.build.nsis).toMatchObject({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createStartMenuShortcut: true,
      menuCategory: "LVIS",
      installerSidebar: "build/installer-sidebar.bmp",
      uninstallerSidebar: "build/uninstaller-sidebar.bmp",
      installerHeader: "build/installer-header.bmp",
      uninstallDisplayName: "LVIS",
      // electron-builder auto-removes `%APPDATA%\LVIS\` (Roaming userData).
      deleteAppDataOnUninstall: true,
      // Custom NSIS hook covers what `deleteAppDataOnUninstall` cannot —
      // selected LVIS_HOME and `%LOCALAPPDATA%\LVIS\` residuals.
      include: "build/installer.nsh",
    });
  });

  it("ships NSIS BMP assets with the electron-builder required dimensions", () => {
    expect(readBmpInfo("build/installer-sidebar.bmp")).toEqual({ width: 164, height: 314, bitsPerPixel: 24 });
    expect(readBmpInfo("build/uninstaller-sidebar.bmp")).toEqual({ width: 164, height: 314, bitsPerPixel: 24 });
    expect(readBmpInfo("build/installer-header.bmp")).toEqual({ width: 150, height: 57, bitsPerPixel: 24 });
    expect(readBmpInfo("build/installer-progress.bmp")).toEqual({ width: 320, height: 180, bitsPerPixel: 24 });
  });

  it("persists only LVIS_HOME from the Windows installer and does not force subprocess homes", () => {
    const script = readFileSync(join(root, "build", "installer.nsh"), "utf8");
    expect(script).toContain("customPageAfterChangeDir");
    expect(script).toContain("!include MUI2.nsh");
    expect(script).toContain("installer-progress.bmp");
    expect(script).toContain("${__FILEDIR__}\\installer-progress.bmp");
    expect(script).not.toContain("BUILD_RESOURCES_DIR");
    expect(script).toContain('!define /ifndef INSTALL_REGISTRY_KEY "Software\\${APP_GUID}"');
    expect(script.indexOf("!ifndef BUILD_UNINSTALLER")).toBeLessThan(script.indexOf("Var LvisHomePage"));
    expect(script.indexOf("Var LvisHomeProgressImage")).toBeLessThan(script.indexOf("Function lvisReadHomeDefault"));
    expect(script).toContain('WriteRegExpandStr HKCU "Environment" "LVIS_HOME" "$LvisHomeSelected"');
    expect(script).toContain(".lvis-data-home");
    expect(script).toContain("Function lvisCanUseHomePath");
    expect(script).toContain('StrCpy $LvisHomeSelected "$0\\LVIS"');
    expect(script).toContain("Existing non-LVIS folders are not allowed");
    expect(script.indexOf("Call lvisWriteHomeMarker")).toBeLessThan(
      script.indexOf('WriteRegExpandStr HKCU "Environment" "LVIS_HOME" "$LvisHomeSelected"'),
    );
    for (const message of [
      "LVIS cannot create the selected data folder",
      "LVIS cannot mark the selected data folder as LVIS-owned",
      "LVIS cannot persist the selected data folder",
      "LVIS cannot persist LVIS_HOME for the current user",
    ]) {
      expect(script).toContain(message);
      expect(script.slice(script.indexOf(message), script.indexOf(message) + 220)).toContain("Abort");
    }
    expect(script).toContain("Function un.lvisCanRemoveHome");
    expect(script.indexOf("!ifdef BUILD_UNINSTALLER")).toBeLessThan(script.indexOf("Function un.lvisReadInstalledHome"));
    expect(script.indexOf("!macro customUnInstall")).toBeLessThan(script.indexOf("!endif", script.indexOf("!macro customUnInstall")));
    expect(script.indexOf("${isUpdated}")).toBeLessThan(script.indexOf('RMDir /r "$LvisHomeSelected"'));
    expect(script).toContain("${AndIfNot} ${isDeleteAppData}");
    expect(script).toContain("Goto lvis_delete_userdata");
    expect(script.indexOf("lvis_delete_userdata:")).toBeLessThan(script.indexOf('RMDir /r "$LvisHomeSelected"'));
    expect(script.indexOf('RMDir /r "$LvisHomeSelected"')).toBeLessThan(
      script.indexOf("Call un.lvisRemoveHomeEnvIfOwned"),
    );
    expect(script).toContain("LVIS data home could not be fully removed, so LVIS_HOME was preserved");
    expect(
      script.slice(
        script.indexOf("LVIS data home could not be fully removed"),
        script.indexOf("Call un.lvisRemoveHomeEnvIfOwned"),
      ),
    ).toContain("Goto lvis_skip_userdata");
    expect(script).toContain("/SD IDNO IDNO lvis_skip_userdata");
    expect(script).toContain("LVIS data home");
    expect(script).not.toContain('"HOME"');
    expect(script).not.toContain('"USERPROFILE"');
    expect(script).not.toContain('"UV_CACHE_DIR"');
  });
});
