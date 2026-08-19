/**
 * feature-namespace SOT helper tests.
 *
 * Validates the Storage Namespace per Feature contract (project CLAUDE.md):
 *   - `~/.lvis/<feature>/` directory mode 0o700, file mode 0o600 (POSIX;
 *     mode bits are not enforced on Windows, so the mode checks skip when
 *     `process.platform` is `"win32"`).
 *   - Atomic write — no `.tmp` sibling survives a completed write, and the
 *     target reflects the latest value (tmpfile + rename).
 *   - readJson is parse-with-fallback: missing file / corrupt JSON →
 *     caller's `fallback`.
 *   - childDir materializes a 0o700 subdirectory.
 *   - openFeatureNamespace rejects path-traversal feature ids.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, statSync, writeFileSync, readdirSync, existsSync, symlinkSync, readFileSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openFeatureNamespace,
  readJsonFile,
  writeJsonAtomic,
  writeFileAtomicAtPath,
} from "../feature-namespace.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const POSIX = process.platform !== "win32";

describe("feature-namespace", () => {
  let prevLvisHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    prevLvisHome = process.env.LVIS_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "lvis-feature-ns-"));
    process.env.LVIS_HOME = tempDir;
  });

  afterEach(async () => {
    if (prevLvisHome === undefined) {
      delete process.env.LVIS_HOME;
    } else {
      process.env.LVIS_HOME = prevLvisHome;
    }
    await cleanupTmpDir(tempDir);
  });

  it("resolves dir to ~/.lvis/<feature>/", () => {
    const ns = openFeatureNamespace("widgets");
    expect(ns.dir).toBe(join(tempDir, "widgets"));
  });

  it("does not create the directory until first write", () => {
    openFeatureNamespace("lazy");
    expect(existsSync(join(tempDir, "lazy"))).toBe(false);
  });

  it("readJson returns the fallback when no file exists", async () => {
    const ns = openFeatureNamespace("widgets");
    const value = await ns.readJson("config.json", { count: 0 });
    expect(value).toEqual({ count: 0 });
  });

  it("writeJson → readJson round-trips", async () => {
    const ns = openFeatureNamespace("widgets");
    await ns.writeJson("config.json", { count: 7, label: "x" });
    const value = await ns.readJson("config.json", { count: 0, label: "" });
    expect(value).toEqual({ count: 7, label: "x" });
  });

  it("readJson falls back on corrupt JSON (parse-with-fallback)", async () => {
    const ns = openFeatureNamespace("widgets");
    await ns.writeJson("config.json", { ok: true });
    writeFileSync(join(tempDir, "widgets", "config.json"), "{ not json", "utf-8");
    const value = await ns.readJson("config.json", { ok: false });
    expect(value).toEqual({ ok: false });
  });

  it("enforces 0o700 dir + 0o600 file modes (POSIX only)", async () => {
    if (!POSIX) return;
    const ns = openFeatureNamespace("widgets");
    await ns.writeJson("config.json", { a: 1 });
    const dirMode = statSync(join(tempDir, "widgets")).mode & 0o777;
    const fileMode = statSync(join(tempDir, "widgets", "config.json")).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("tightens a pre-existing wider directory back to 0o700 (POSIX only)", async () => {
    if (!POSIX) return;
    const { mkdirSync, chmodSync } = await import("node:fs");
    const dir = join(tempDir, "widgets");
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    const ns = openFeatureNamespace("widgets");
    await ns.writeJson("config.json", { a: 1 });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("leaves no .tmp sibling after a completed write (atomic)", async () => {
    const ns = openFeatureNamespace("widgets");
    await ns.writeJson("config.json", { a: 1 });
    const entries = readdirSync(join(tempDir, "widgets"));
    expect(entries).toEqual(["config.json"]);
  });

  it("does not write through a symlink planted at the staging path", async () => {
    // The staging name was a FIXED `${target}.tmp`. Anything that could predict
    // the target could therefore plant that path first, and `fs.writeFile`
    // follows a symlink: the payload landed at the planter's destination and
    // the subsequent `rename` moved the LINK over the live path, leaving
    // `~/.lvis/<feature>/<file>` pointing wherever they chose. A random name
    // plus O_CREAT|O_EXCL means the writer never opens a path that exists.
    const featureDir = join(tempDir, "widgets");
    mkdirSync(featureDir, { recursive: true, mode: 0o700 });
    const target = join(featureDir, "config.json");
    const outside = join(tempDir, "attacker-owned.json");
    writeFileSync(outside, "untouched");
    const predictableStaging = `${target}.tmp`;
    symlinkSync(outside, predictableStaging);

    await writeFileAtomicAtPath(target, "fresh");

    expect(readFileSync(target, "utf-8")).toBe("fresh");
    // Nothing was written through the link, and the link was not renamed onto
    // the live path.
    expect(readFileSync(outside, "utf-8")).toBe("untouched");
    expect(lstatSync(predictableStaging).isSymbolicLink()).toBe(true);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
  });

  it("gives two concurrent writers to one target their own staging file", async () => {
    // With a fixed `${target}.tmp` both writers staged into the same file and
    // both renamed it, so the survivor could hold either payload or a splice of
    // the two. work-board-store and routines-store both route here, so that was
    // two live stores under ~/.lvis.
    const featureDir = join(tempDir, "widgets");
    mkdirSync(featureDir, { recursive: true, mode: 0o700 });
    const target = join(featureDir, "shared.json");
    const a = "A".repeat(200_000);
    const b = "B".repeat(200_000);
    await Promise.all([
      writeFileAtomicAtPath(target, a),
      writeFileAtomicAtPath(target, b),
    ]);
    expect([a, b]).toContain(readFileSync(target, "utf-8"));
    expect(readdirSync(featureDir)).toEqual(["shared.json"]);
  });

  it("leaves no staging file behind when the write fails", async () => {
    const featureDir = join(tempDir, "widgets");
    mkdirSync(featureDir, { recursive: true, mode: 0o700 });
    const target = join(featureDir, "config.json");
    // A directory at the target makes `rename` fail after the bytes are staged.
    mkdirSync(target, { recursive: true });
    await expect(writeFileAtomicAtPath(target, "fresh")).rejects.toThrow();
    expect(readdirSync(featureDir)).toEqual(["config.json"]);
  });

  it("childDir materializes a 0o700 subdirectory", async () => {
    const ns = openFeatureNamespace("widgets");
    const child = await ns.childDir("sessions");
    expect(child).toBe(join(tempDir, "widgets", "sessions"));
    expect(statSync(child).isDirectory()).toBe(true);
    if (POSIX) {
      expect(statSync(child).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects path-traversal feature ids", () => {
    expect(() => openFeatureNamespace("../escape")).toThrow(/invalid featureId/);
    expect(() => openFeatureNamespace("a/b")).toThrow(/invalid featureId/);
    expect(() => openFeatureNamespace("")).toThrow(/invalid featureId/);
  });

  it("writeFileAtomicAtPath writes raw (non-JSON) bytes with 0o600 + 0o700 parent", async () => {
    const filePath = join(tempDir, "raw-feature", "note.md");
    await writeFileAtomicAtPath(filePath, "# hello\n");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(filePath, "utf-8")).toBe("# hello\n");
    expect(readdirSync(join(tempDir, "raw-feature"))).toEqual(["note.md"]);
    if (POSIX) {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(statSync(join(tempDir, "raw-feature")).mode & 0o777).toBe(0o700);
    }
  });

  it("readJsonFile returns the fallback for a missing path", async () => {
    const value = await readJsonFile(join(tempDir, "missing.json"), { raw: "fallback" });
    expect(value).toEqual({ raw: "fallback" });
  });

  it("writeJsonAtomic overwrites an existing file in place", async () => {
    const dir = join(tempDir, "widgets");
    await writeJsonAtomic(dir, "config.json", { v: 1 });
    await writeJsonAtomic(dir, "config.json", { v: 2 });
    const value = await readJsonFile(join(dir, "config.json"), { v: 0 });
    expect(value).toEqual({ v: 2 });
  });
});
