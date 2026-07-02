import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  assertReadableFilePath,
  isBinaryFile,
  isGlobPattern,
  readTextFileWindow,
} from "../file-read-core.js";

describe("isGlobPattern", () => {
  it("flags glob patterns as non-files", () => {
    expect(isGlobPattern("**/*architecture*.md")).toBe(true);
    expect(isGlobPattern("src/**/index.ts")).toBe(true);
    expect(isGlobPattern("foo?.ts")).toBe(true);
    expect(isGlobPattern("a{b,c}.ts")).toBe(true);
    expect(isGlobPattern("[abc].ts")).toBe(true);
  });
  it("accepts concrete paths", () => {
    expect(isGlobPattern("/Users/x/docs/architecture.md")).toBe(false);
    expect(isGlobPattern("./relative/file.ts")).toBe(false);
    expect(isGlobPattern("C:\\workspace\\report.md")).toBe(false);
  });
});

describe("assertReadableFilePath", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lvis-read-core-"));
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "in.md"), "# in scope\nline2\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("allows a concrete file inside cwd", () => {
    const verdict = assertReadableFilePath(join(root, "in.md"), root, []);
    expect(verdict.ok).toBe(true);
  });

  it("allows a file inside an extra allowed directory", () => {
    const other = mkdtempSync(join(tmpdir(), "lvis-read-core-extra-"));
    writeFileSync(join(other, "x.txt"), "hi");
    const verdict = assertReadableFilePath(join(other, "x.txt"), root, [other]);
    expect(verdict.ok).toBe(true);
    rmSync(other, { recursive: true, force: true });
  });

  it("rejects a glob pattern as not-a-file (before any stat)", () => {
    const verdict = assertReadableFilePath("**/*architecture*.md", root, []);
    expect(verdict).toEqual({ ok: false, error: "not-a-file" });
  });

  it("rejects Layer 0 sensitive paths even when the parent root is allowed", () => {
    const sshKey = join(homedir(), ".ssh", "id_rsa");
    const verdict = assertReadableFilePath(sshKey, root, [homedir()]);
    expect(verdict).toEqual({ ok: false, error: "sensitive-path" });
  });

  it("rejects a path outside cwd and the extra roots", () => {
    const outside = join(homedir(), "Documents", "lvis-outside-scope-xyz.txt");
    const verdict = assertReadableFilePath(outside, root, []);
    expect(verdict).toEqual({ ok: false, error: "path-not-allowed" });
  });
});

describe("readTextFileWindow / isBinaryFile", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lvis-read-core-io-"));
    writeFileSync(join(root, "text.txt"), "a\nb\nc\nd\ne\n");
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reads a bounded line window and reports truncation", async () => {
    const first = await readTextFileWindow(join(root, "text.txt"), 0, 2);
    expect(first.lines).toEqual(["a", "b"]);
    expect(first.truncated).toBe(true);
    const rest = await readTextFileWindow(join(root, "text.txt"), 2, 100);
    expect(rest.lines).toEqual(["c", "d", "e"]);
    expect(rest.truncated).toBe(false);
  });

  it("detects a NUL byte as binary", async () => {
    expect(await isBinaryFile(join(root, "bin.dat"))).toBe(true);
    expect(await isBinaryFile(join(root, "text.txt"))).toBe(false);
  });
});
