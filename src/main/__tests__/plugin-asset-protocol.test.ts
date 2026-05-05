import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PLUGIN_ASSET_SCHEME,
  pluginAssetUrlFromRealPath,
  registerPluginAssetProtocolScheme,
  resolvePluginAssetRequest,
} from "../plugin-asset-protocol.js";

const tempDirs: string[] = [];

function fixture(): { root: string; entry: string; asset: string } {
  const root = mkdtempSync(join(tmpdir(), "lvis-plugin-assets-"));
  tempDirs.push(root);
  const entry = join(root, "dist", "ui.js");
  const asset = join(root, "dist", "icon.svg");
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(entry, "export const ok = true;", "utf8");
  writeFileSync(asset, "<svg />", "utf8");
  return { root, entry, asset };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin asset protocol", () => {
  it("registers lvis-plugin as a standard secure scheme", () => {
    const mockProtocol = { registerSchemesAsPrivileged: vi.fn() };

    registerPluginAssetProtocolScheme(mockProtocol);

    expect(mockProtocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: PLUGIN_ASSET_SCHEME,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
        },
      },
    ]);
  });

  it("builds stable lvis-plugin URLs from real contained paths", () => {
    const { root, entry } = fixture();

    expect(pluginAssetUrlFromRealPath(realpathSync(root), realpathSync(entry))).toBe(
      "lvis-plugin://asset/dist/ui.js",
    );
  });

  it("resolves relative plugin asset URLs inside the plugin root", () => {
    const { root, asset } = fixture();

    expect(resolvePluginAssetRequest(root, "lvis-plugin://asset/dist/icon.svg")).toBe(
      realpathSync(asset),
    );
  });

  it("rejects traversal outside the plugin root", () => {
    const { root } = fixture();

    expect(resolvePluginAssetRequest(root, "lvis-plugin://asset/../package.json")).toBeNull();
  });

  it("rejects non-plugin-asset schemes and hosts", () => {
    const { root } = fixture();

    expect(resolvePluginAssetRequest(root, "file:///tmp/plugin.js")).toBeNull();
    expect(resolvePluginAssetRequest(root, "lvis-plugin://other/dist/ui.js")).toBeNull();
  });
});
