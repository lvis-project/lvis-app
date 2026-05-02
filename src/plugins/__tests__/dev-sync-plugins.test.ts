/**
 * Unit tests for scripts/dev-sync-plugins.mjs — the developer plugin
 * sync workflow that replaces the legacy dev-link symlink path.
 *
 * The script itself runs at `bun run dev` time and operates on the
 * sibling lvis-plugin-* repos + `~/.lvis/plugins/`. We can't drive the
 * full workflow in vitest (it scans the actual workspace) but we can
 * import its pure helpers and assert the behaviours that matter for
 * trust-boundary correctness.
 */
import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The .mjs script exports the pure helpers we want to verify. Importing
// it here also asserts the script is parseable and side-effect-free at
// import time when run outside the workspace.
//
// Vite resolves the .mjs through node's normal module loader.
import {
  buildCopyFilter,
  isSafePluginId,
  removeAny,
  // @ts-ignore — JS file, no .d.ts
} from "../../../scripts/dev-sync-plugins.mjs";

describe("dev-sync-plugins — isSafePluginId", () => {
  it("accepts safe ids", () => {
    expect(isSafePluginId("agent-hub")).toBe(true);
    expect(isSafePluginId("com.lge.sample")).toBe(true);
    expect(isSafePluginId("ms_graph")).toBe(true);
  });
  it("rejects path-traversal and unsafe characters", () => {
    expect(isSafePluginId("..")).toBe(false);
    expect(isSafePluginId("../escape")).toBe(false);
    expect(isSafePluginId("evil/../x")).toBe(false);
    expect(isSafePluginId("with space")).toBe(false);
    expect(isSafePluginId("")).toBe(false);
    expect(isSafePluginId(undefined as unknown as string)).toBe(false);
  });
});

describe("dev-sync-plugins — buildCopyFilter", () => {
  it("excludes electron / @electron / .bin / .git", () => {
    const root = "/tmp/plugin";
    const filter = buildCopyFilter(root);
    expect(filter("/tmp/plugin/.git/HEAD")).toBe(false);
    expect(filter("/tmp/plugin/node_modules/electron/cli.js")).toBe(false);
    expect(filter("/tmp/plugin/node_modules/@electron/remote/index.js")).toBe(false);
    expect(filter("/tmp/plugin/node_modules/.bin/tsc")).toBe(false);
  });
  it("includes ordinary plugin files", () => {
    const root = "/tmp/plugin";
    const filter = buildCopyFilter(root);
    expect(filter("/tmp/plugin/dist/index.js")).toBe(true);
    expect(filter("/tmp/plugin/plugin.json")).toBe(true);
    expect(filter("/tmp/plugin/node_modules/lodash/index.js")).toBe(true);
  });
});

describe("dev-sync-plugins — removeAny", () => {
  // The migration story: a user with the legacy `dev:link` workflow has
  // ~/.lvis/plugins/<id>/plugin.json as a symlink AND ~/.lvis/plugins/<id>/dist
  // as a symlink. The new dev:sync script must wipe these symlinks before
  // copying real files, otherwise cpSync would either follow the symlink
  // (writing into the workspace!) or fail. removeAny is the function that
  // performs that wipe — it must be idempotent and handle three states:
  // missing, symlink, real file/dir.
  it("removes a symlink without touching the target", () => {
    const dir = join(tmpdir(), `dev-sync-removeAny-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "real");
    const linkPath = join(dir, "link");
    mkdirSync(target);
    writeFileSync(join(target, "marker"), "keep me", "utf-8");
    symlinkSync(target, linkPath, "dir");

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    removeAny(linkPath);
    expect(existsSync(linkPath)).toBe(false);
    // The symlink target must be untouched — this is the crucial property
    // for migration: we must NEVER blow away the workspace plugin repo.
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, "marker"))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
  it("removes a real directory", () => {
    const dir = join(tmpdir(), `dev-sync-removeAny-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const realDir = join(dir, "rdir");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "f.txt"), "x", "utf-8");

    removeAny(realDir);
    expect(existsSync(realDir)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
  it("is a no-op for missing paths", () => {
    expect(() => removeAny(join(tmpdir(), `nonexistent-${Math.random()}`))).not.toThrow();
  });
});
