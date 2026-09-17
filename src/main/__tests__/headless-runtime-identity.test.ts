import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _resetForTest, getIsPackaged } from "../../boot/dev-flags.js";
import { headlessPackagedMarkerPath } from "../../../scripts/lib/headless-packaged-marker.mjs";
import { configureHeadlessRuntimeIdentity } from "../headless-runtime-identity.js";

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "lvis-headless-identity-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  _resetForTest();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("headless runtime identity", () => {
  it("treats a missing marker as source development state", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      LVIS_DEV: "1",
      LVIS_WHITELIST_OFFLINE: "1",
    };

    expect(configureHeadlessRuntimeIdentity(root(), env)).toBe(false);
    expect(getIsPackaged()).toBe(false);
    expect(env).toEqual({
      NODE_ENV: "production",
      LVIS_DEV: "1",
      LVIS_WHITELIST_OFFLINE: "1",
    });
  });

  it.each([undefined, "test", "development"])(
    "makes a valid packaged marker authoritative when NODE_ENV=%s",
    (nodeEnv) => {
      const projectRoot = root();
      writeFileSync(headlessPackagedMarkerPath(projectRoot), new Uint8Array());
      const env: NodeJS.ProcessEnv = {
        NODE_ENV: nodeEnv,
        VITEST: "1",
        LVIS_DEV: "1",
        LVIS_WHITELIST_OFFLINE: "1",
        LVIS_HOME: "/retained/home",
      };

      expect(configureHeadlessRuntimeIdentity(projectRoot, env)).toBe(true);
      expect(getIsPackaged()).toBe(true);
      expect(env).toEqual({ NODE_ENV: "production", LVIS_HOME: "/retained/home" });
    },
  );

  it.each(["directory", "nonzero"])("fails startup for a malformed %s marker", (kind) => {
    const projectRoot = root();
    const markerPath = headlessPackagedMarkerPath(projectRoot);
    if (kind === "directory") mkdirSync(markerPath);
    else writeFileSync(markerPath, "not-empty");

    expect(() => configureHeadlessRuntimeIdentity(projectRoot, {})).toThrow(
      "Packaged runtime marker is invalid",
    );
  });

  it.skipIf(process.platform === "win32")("fails startup for a symlink marker", () => {
    const projectRoot = root();
    const target = join(projectRoot, "target");
    writeFileSync(target, new Uint8Array());
    symlinkSync(target, headlessPackagedMarkerPath(projectRoot));

    expect(() => configureHeadlessRuntimeIdentity(projectRoot, {})).toThrow(
      "Packaged runtime marker is invalid",
    );
  });
});
