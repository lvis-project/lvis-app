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
          corsEnabled: true,
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

  it("resolves relative plugin asset URLs inside the plugin root", async () => {
    const { root, asset } = fixture();

    await expect(resolvePluginAssetRequest(root, "lvis-plugin://asset/dist/icon.svg")).resolves.toBe(
      realpathSync(asset),
    );
  });

  it("keeps relative module imports rooted at the lvis-plugin asset URL", async () => {
    const { root, entry, asset } = fixture();
    const entryUrl = pluginAssetUrlFromRealPath(realpathSync(root), realpathSync(entry));
    const relativeAssetUrl = new URL("./icon.svg", entryUrl).toString();

    expect(relativeAssetUrl).toBe("lvis-plugin://asset/dist/icon.svg");
    await expect(resolvePluginAssetRequest(root, relativeAssetUrl)).resolves.toBe(
      realpathSync(asset),
    );
  });

  it("rejects traversal outside the plugin root", async () => {
    const { root } = fixture();

    await expect(resolvePluginAssetRequest(root, "lvis-plugin://asset/../package.json")).resolves.toBeNull();
  });

  it("rejects non-plugin-asset schemes and hosts", async () => {
    const { root } = fixture();

    await expect(resolvePluginAssetRequest(root, "file:///tmp/plugin.js")).resolves.toBeNull();
    await expect(resolvePluginAssetRequest(root, "lvis-plugin://other/dist/ui.js")).resolves.toBeNull();
  });
});
