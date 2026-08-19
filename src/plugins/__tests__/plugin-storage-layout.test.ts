/**
 * Plugin storage layout — the security boundary inside a plugin root.
 *
 * `resolvePluginWritableRoot` is the single derivation every producer of
 * `ownerPluginSandboxRoot` uses. It must point at the plugin's data dir and
 * never at the plugin root, because the root holds the bundle the next load
 * imports into the Electron main process.
 */
import { describe, it, expect } from "vitest";
import { resolve, sep } from "node:path";
import {
  PLUGIN_DATA_DIR_NAME,
  PLUGIN_WORKER_RUN_DIR_NAME,
  resolvePluginWritableRoot,
} from "../plugin-storage-layout.js";
import { lvisHome } from "../../shared/lvis-home.js";
import { isPathWithin, isResolvedPathWithin } from "../plugin-storage-containment.js";

const PLUGIN_ID = "lvis-plugin-layout-fixture";

describe("resolvePluginWritableRoot", () => {
  it("resolves to the plugin's data dir, not the plugin root", () => {
    const pluginRoot = resolve(lvisHome(), "plugins", PLUGIN_ID);
    const writable = resolvePluginWritableRoot(PLUGIN_ID);
    expect(writable).toBe(resolve(pluginRoot, PLUGIN_DATA_DIR_NAME));
    expect(writable).not.toBe(pluginRoot);
  });

  it("leaves the plugin's own executable bundle and manifest outside the jail", () => {
    const pluginRoot = resolve(lvisHome(), "plugins", PLUGIN_ID);
    const writable = resolvePluginWritableRoot(PLUGIN_ID);
    for (const payload of ["dist", "dist/index.js", "plugin.json"]) {
      expect(resolve(pluginRoot, payload).startsWith(`${writable}/`)).toBe(false);
    }
  });

  it("leaves the host-allocated worker run dir outside the jail", () => {
    // Worker control sockets are host-created and host-owned; the plugin never
    // needs write access to them.
    const pluginRoot = resolve(lvisHome(), "plugins", PLUGIN_ID);
    const writable = resolvePluginWritableRoot(PLUGIN_ID);
    const runDir = resolve(pluginRoot, PLUGIN_WORKER_RUN_DIR_NAME);
    expect(runDir.startsWith(`${writable}/`)).toBe(false);
  });
});

describe("isPathWithin", () => {
  const under = (root: string, ...segments: string[]) => resolve(root, ...segments);

  it("accepts a descendant and the root itself", () => {
    const root = resolve("/srv", "data");
    expect(isPathWithin(root, under(root, "file.txt"))).toBe(true);
    expect(isPathWithin(root, root)).toBe(true);
  });

  it("refuses a sibling whose name merely starts with the root's", () => {
    // The reason this predicate is shared rather than rewritten per site: a
    // bare `startsWith` accepts `/srv/data-evil` for a root of `/srv/data`.
    const root = resolve("/srv", "data");
    expect(isPathWithin(root, `${root}-evil`)).toBe(false);
  });

  it("accepts a descendant of a root that already ends in a separator", () => {
    // A second separator would be appended and match nothing, so a legitimate
    // path would read as outside its own root. On Windows a drive root is
    // exactly this shape, which is where it would have surfaced first — as a
    // plugin whose own directory looks foreign to it, not as an escape.
    const root = resolve("/srv", "data");
    const rootWithTrailingSeparator = `${root}${sep}`;
    expect(isPathWithin(rootWithTrailingSeparator, under(root, "file.txt"))).toBe(true);
    expect(isPathWithin(rootWithTrailingSeparator, `${root}-evil`)).toBe(false);
  });
});

describe("isResolvedPathWithin", () => {
  it("keeps a directory whose own name begins with two dots", () => {
    // The predicate this replaced was `relative(root, target)` +
    // `!rel.startsWith("..")`, spelled identically at seven sites. For
    // `<root>/..foo` that relative path IS `"..foo"`, so every one of the seven
    // read a plainly-contained directory as an escape. Nothing named `..foo`
    // happened to exist, which is why it never showed up as a bug report.
    const root = resolve("/srv", "data");
    expect(isResolvedPathWithin(root, resolve(root, "..foo"))).toBe(true);
    expect(isResolvedPathWithin(root, resolve(root, "..foo", "bar.txt"))).toBe(true);
  });

  it("still refuses the real escapes the old predicate caught", () => {
    const root = resolve("/srv", "data");
    expect(isResolvedPathWithin(root, resolve("/srv", "data-evil"))).toBe(false);
    expect(isResolvedPathWithin(root, resolve("/etc", "passwd"))).toBe(false);
    // `..` as a whole segment is an escape and must stay one.
    expect(isResolvedPathWithin(root, `${root}${sep}..${sep}evil`)).toBe(false);
  });

  it("collapses traversal segments before deciding", () => {
    const root = resolve("/srv", "data");
    expect(isResolvedPathWithin(root, `${root}${sep}a${sep}..${sep}b`)).toBe(true);
  });

  it("treats the root itself as contained", () => {
    const root = resolve("/srv", "data");
    expect(isResolvedPathWithin(root, root)).toBe(true);
    expect(isResolvedPathWithin(`${root}${sep}`, resolve(root, "f.txt"))).toBe(true);
  });

  it("anchors a relative argument the same way `path.relative` did", () => {
    // Behaviour the seven copies had by accident (both sides went through
    // `path.relative`, which resolves against cwd) and that callers still rely
    // on. Made explicit here so a future edit cannot drop it silently.
    expect(isResolvedPathWithin(process.cwd(), "package.json")).toBe(true);
    expect(isResolvedPathWithin(resolve(process.cwd(), "src"), "package.json")).toBe(false);
  });
});
