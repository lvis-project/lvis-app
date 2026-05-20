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

  it("removes user data on Windows uninstall (Roaming + ~/.lvis cleanup wired)", () => {
    const pkg = readPackageJson();
    expect(pkg.build.nsis).toMatchObject({
      oneClick: true,
      createStartMenuShortcut: true,
      uninstallDisplayName: "LVIS",
      // electron-builder auto-removes `%APPDATA%\LVIS\` (Roaming userData).
      deleteAppDataOnUninstall: true,
      // Custom NSIS hook covers what `deleteAppDataOnUninstall` cannot —
      // `%USERPROFILE%\.lvis\` (LVIS_HOME) and `%LOCALAPPDATA%\LVIS\` residuals.
      include: "build/installer.nsh",
    });
  });
});
