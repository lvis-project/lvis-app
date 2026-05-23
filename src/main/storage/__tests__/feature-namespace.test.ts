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
import { mkdtempSync, rmSync, statSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openFeatureNamespace,
  readJsonFile,
  writeJsonAtomic,
  writeFileAtomicAtPath,
} from "../feature-namespace.js";

const POSIX = process.platform !== "win32";

describe("feature-namespace", () => {
  let prevLvisHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    prevLvisHome = process.env.LVIS_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "lvis-feature-ns-"));
    process.env.LVIS_HOME = tempDir;
  });

  afterEach(() => {
    if (prevLvisHome === undefined) {
      delete process.env.LVIS_HOME;
    } else {
      process.env.LVIS_HOME = prevLvisHome;
    }
    rmSync(tempDir, { recursive: true, force: true });
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
