/**
 * Plugin storage layout — the security boundary inside a plugin root.
 *
 * `resolvePluginWritableRoot` is the single derivation every producer of
 * `ownerPluginSandboxRoot` uses. It must point at the plugin's data dir and
 * never at the plugin root, because the root holds the bundle the next load
 * imports into the Electron main process.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  PLUGIN_DATA_DIR_NAME,
  PLUGIN_OWN_SOCKET_DIR_NAME,
  PLUGIN_WORKER_RUN_DIR_NAME,
  assertUnixSocketPathFits,
  carryPluginDataDir,
  pluginPayloadCopyFilter,
  resolvePluginSocketDir,
  resolvePluginWritableRoot,
} from "../plugin-storage-layout.js";
import { lvisHome } from "../../shared/lvis-home.js";
import { isPathWithin, isResolvedPathWithin } from "../plugin-storage-containment.js";
import { PLUGIN_DATA_FIXTURE, readPluginDataFixture, seedPluginDataFixture } from "./test-helpers.js";

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

describe("resolvePluginSocketDir", () => {
  it("sits BESIDE the data directory, not inside it", () => {
    // Inside would be simpler and wrong. The Unix-socket ALLOW is scoped to one
    // directory on macOS, so putting the socket dir under `data` would make
    // every ordinary plugin file share that scope — and the case in
    // `confined-plugin-child.test.ts` that proves the ALLOW is separate from
    // the write jail would have nothing left to measure.
    const dataDir = resolvePluginWritableRoot(PLUGIN_ID);
    expect(resolvePluginSocketDir(dataDir)).toBe(
      resolve(lvisHome(), "plugins", PLUGIN_ID, PLUGIN_OWN_SOCKET_DIR_NAME),
    );
  });

  it("follows a relocated data directory rather than rebuilding from the home", () => {
    // The property that keeps the granted directory and the created one equal.
    // A derivation from `lvisHome()` and the id would answer with the
    // production path for a plugin whose data dir is somewhere else — and the
    // child would then be handed a directory the sandbox never heard of.
    expect(resolvePluginSocketDir("/somewhere/else/plugins/p/data")).toBe(
      `/somewhere/else/plugins/p/${PLUGIN_OWN_SOCKET_DIR_NAME}`,
    );
  });
});

describe("assertUnixSocketPathFits", () => {
  const limit = process.platform === "darwin" ? 103 : 107;

  it("accepts a path exactly at the limit", () => {
    expect(() => assertUnixSocketPathFits("/".repeat(limit), "probe")).not.toThrow();
  });

  it("refuses one byte over, and says the length rather than leaving EINVAL to explain it", () => {
    // The failure this replaces is `bind()` answering `EINVAL` — "malformed
    // address" — which names nothing and sends the reader at the address
    // family, the permissions, anywhere but a length.
    expect(() => assertUnixSocketPathFits("/".repeat(limit + 1), "probe")).toThrow(
      new RegExp(`${String(limit + 1)} bytes`),
    );
    expect(() => assertUnixSocketPathFits("/".repeat(limit + 1), "worker control socket")).toThrow(
      /worker control socket/,
    );
  });

  it("counts BYTES, not characters", () => {
    // A path is bytes to the kernel. A limit measured in JS string length would
    // pass a name of multi-byte characters that the kernel then refuses — the
    // guard would be the thing making the failure opaque.
    const multiByte = "가".repeat(Math.ceil(limit / 3));
    expect(multiByte.length).toBeLessThanOrEqual(limit);
    expect(() => assertUnixSocketPathFits(multiByte, "probe")).toThrow(/bytes/);
  });
});

describe("carryPluginDataDir", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "plugin-data-carry-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("moves the data directory between roots with every file intact", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(from);
    await mkdir(to);
    await seedPluginDataFixture(from);

    await expect(carryPluginDataDir(from, to)).resolves.toBe(true);

    expect(await readPluginDataFixture(to)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(existsSync(join(from, PLUGIN_DATA_DIR_NAME))).toBe(false);
  });

  it("reports nothing to carry when the source root holds no data directory", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(from);
    await mkdir(to);

    await expect(carryPluginDataDir(from, to)).resolves.toBe(false);

    expect(existsSync(join(to, PLUGIN_DATA_DIR_NAME))).toBe(false);
  });

  it("refuses to replace a data directory the target root already holds", async () => {
    const from = join(root, "old");
    const to = join(root, "new");
    await mkdir(from);
    await mkdir(to);
    await seedPluginDataFixture(from);
    await seedPluginDataFixture(to);

    await expect(carryPluginDataDir(from, to)).rejects.toThrow(/both roots hold a plugin data directory/);

    expect(await readPluginDataFixture(from)).toEqual(PLUGIN_DATA_FIXTURE);
    expect(await readPluginDataFixture(to)).toEqual(PLUGIN_DATA_FIXTURE);
  });
});

describe("pluginPayloadCopyFilter", () => {
  it("excludes the root's own data directory and nothing else", () => {
    const pluginRoot = resolve(sep, "plugins", PLUGIN_ID);
    const filter = pluginPayloadCopyFilter(pluginRoot);
    expect(filter(resolve(pluginRoot, PLUGIN_DATA_DIR_NAME))).toBe(false);
    expect(filter(resolve(pluginRoot, "plugin.json"))).toBe(true);
    expect(filter(resolve(pluginRoot, "dist", PLUGIN_DATA_DIR_NAME))).toBe(true);
    expect(filter(resolve(pluginRoot, PLUGIN_WORKER_RUN_DIR_NAME))).toBe(true);
  });
});
