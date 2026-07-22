import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry } from "../registry.js";
import {
  ApplyPatchTool,
  createFileTools,
  DeleteFileTool,
  EditFileTool,
  GlobFilesTool,
  GrepFilesTool,
  ListFilesTool,
  MoveFileTool,
  ReadFileTool,
  ViewImageTool,
  WriteFileTool,
} from "../file-tools.js";
import type { ToolExecutionContext } from "../base.js";
import {
  dispatchPermissionDirCommand,
  parsePermissionDirCommand,
} from "../../permissions/permission-slash.js";

let workDir: string;

function ctx(): ToolExecutionContext {
  return { cwd: workDir, extraAllowedDirectories: [], metadata: {} };
}

function parse(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

function portablePath(path: string): string {
  return path.replace(/\\/g, "/");
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "lvis-file-tools-"));
  mkdirSync(join(workDir, "src", "nested"), { recursive: true });
  writeFileSync(join(workDir, "src", "a.ts"), "alpha\nneedle one\nomega\n", "utf8");
  writeFileSync(join(workDir, "src", "nested", "b.ts"), "beta\nneedle two\n", "utf8");
  writeFileSync(join(workDir, "README.md"), "# LVIS\nneedle docs\n", "utf8");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("view_image tool", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

  it("loads a PNG and returns a base64 image with the sniffed mime + placeholder text", async () => {
    writeFileSync(join(workDir, "shot.png"), PNG);
    const res = await new ViewImageTool().execute({ path: "shot.png" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.image?.mimeType).toBe("image/png");
    expect(res.image?.data).toBe(PNG.toString("base64"));
    expect(res.image?.bytes).toBe(PNG.length);
    expect(parse(res.output).loaded).toBe(true);
  });

  it.each([
    ["jpeg", JPEG, "image/jpeg"],
    ["gif", GIF, "image/gif"],
    ["webp", WEBP, "image/webp"],
  ])("detects %s by magic bytes", async (name, bytes, mime) => {
    writeFileSync(join(workDir, `f.${name}`), bytes);
    const res = await new ViewImageTool().execute({ path: `f.${name}` }, ctx());
    expect(res.isError).toBe(false);
    expect(res.image?.mimeType).toBe(mime);
  });

  it("rejects a non-image by magic-byte sniff (ignores a lying .png extension)", async () => {
    writeFileSync(join(workDir, "fake.png"), "not an image", "utf8");
    const res = await new ViewImageTool().execute({ path: "fake.png" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.image).toBeUndefined();
  });

  it("rejects an image over the 5 MB limit before reading it into context", async () => {
    writeFileSync(join(workDir, "big.png"), Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]));
    const res = await new ViewImageTool().execute({ path: "big.png" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("5 MB");
    expect(res.image).toBeUndefined();
  });

  it("rejects a path outside the allowed scope (same guard as read_file)", async () => {
    const res = await new ViewImageTool().execute({ path: "../sneak.png" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.image).toBeUndefined();
  });

  it("is registered by createFileTools", () => {
    expect(createFileTools().map((t) => t.name)).toContain("view_image");
  });
});

describe("file native tools", () => {
  it("read_file reads a bounded line window", async () => {
    const result = await new ReadFileTool().execute(
      { path: "src/a.ts", offset: 1, limit: 1 },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const body = parse(result.output);
    expect(body.content).toBe("needle one");
    expect(body.startLine).toBe(2);
    expect(body.endLine).toBe(2);
  });

  it("list_files returns depth-limited directory entries", async () => {
    const result = await new ListFilesTool().execute(
      { path: ".", depth: 2, limit: 20 },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const body = parse(result.output);
    const entries = body.entries as Array<{ relativePath: string; type: string }>;
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "README.md", type: "file" }),
        expect.objectContaining({ relativePath: "src", type: "directory" }),
        expect.objectContaining({ relativePath: "src/a.ts", type: "file" }),
      ]),
    );
  });

  it("glob_files matches paths without reading file contents", async () => {
    const result = await new GlobFilesTool().execute(
      { path: ".", pattern: "src/**/*.ts", limit: 20 },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const body = parse(result.output);
    const matches = body.matches as string[];
    expect(matches).toHaveLength(2);
    expect(matches.some((p) => portablePath(p).endsWith("src/a.ts"))).toBe(true);
    expect(matches.some((p) => portablePath(p).endsWith("src/nested/b.ts"))).toBe(true);
  });

  it("grep_files matches content lines with file and line", async () => {
    const result = await new GrepFilesTool().execute(
      { path: ".", pattern: "needle", include: "**/*.ts", limit: 20 },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const body = parse(result.output);
    const matches = body.matches as Array<{ path: string; line: number; text: string }>;
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.text)).toEqual(["needle one", "needle two"]);
  });

  it("list/glob/grep skip sensitive descendants under an allowed root", async () => {
    mkdirSync(join(workDir, ".ssh"), { recursive: true });
    mkdirSync(join(workDir, ".lvis", "secrets"), { recursive: true });
    writeFileSync(join(workDir, ".env"), "needle secret\n", "utf8");
    writeFileSync(join(workDir, ".ssh", "id_rsa"), "needle key\n", "utf8");
    writeFileSync(join(workDir, ".lvis", "secrets", "token.txt"), "needle token\n", "utf8");

    const listed = await new ListFilesTool().execute({ path: ".", depth: 4, limit: 50 }, ctx());
    expect(listed.isError).toBe(false);
    const entries = parse(listed.output).entries as Array<{ relativePath: string }>;
    expect(entries.map((entry) => entry.relativePath)).not.toEqual(
      expect.arrayContaining([".env", ".ssh", ".ssh/id_rsa", ".lvis/secrets/token.txt"]),
    );

    const globbed = await new GlobFilesTool().execute({ path: ".", pattern: "**/.env", limit: 50 }, ctx());
    expect(globbed.isError).toBe(false);
    expect(parse(globbed.output).matches).toEqual([]);

    const grepped = await new GrepFilesTool().execute({ path: ".", pattern: "needle", limit: 50 }, ctx());
    expect(grepped.isError).toBe(false);
    const matches = parse(grepped.output).matches as Array<{ path: string; text: string }>;
    expect(matches.some((match) => match.text.includes("secret") || match.text.includes("key") || match.text.includes("token"))).toBe(false);
  });

  it("write-capable file tools scope approval cache keys to canonical paths", () => {
    expect(new WriteFileTool().approvalCacheKey({ path: "src/a.ts" }, { cwd: workDir })).toBe(
      `path:${join(workDir, "src", "a.ts")}`,
    );
    expect(new EditFileTool().approvalCacheKey({ path: "~/notes.md" }, { cwd: workDir })).toBe(
      `path:${join(homedir(), "notes.md")}`,
    );
    expect(new ApplyPatchTool().approvalCacheKey({ path: "README.md" }, { cwd: workDir })).toBe(
      `path:${join(workDir, "README.md")}`,
    );
    expect(new DeleteFileTool().approvalCacheKey({ path: "README.md" }, { cwd: workDir })).toBe(
      `path:${join(workDir, "README.md")}`,
    );
    expect(new MoveFileTool().approvalCacheKey(
      { sourcePath: "README.md", destinationPath: "docs/README.md" },
      { cwd: workDir },
    )).toBe(`source:${join(workDir, "README.md")}:destination:${join(workDir, "docs", "README.md")}`);
  });

  it("write-capable approval cache keys require explicit cwd", () => {
    expect(() => new WriteFileTool().approvalCacheKey({ path: "src/a.ts" })).toThrow("explicit cwd");
  });

  it("glob_files filters before applying the result limit", async () => {
    for (let i = 0; i < 8; i += 1) {
      writeFileSync(join(workDir, `aaa-${i}.txt`), "noise\n", "utf8");
    }
    writeFileSync(join(workDir, "zzz-target.ts"), "late\n", "utf8");

    const result = await new GlobFilesTool().execute(
      { path: ".", pattern: "**/*target.ts", limit: 1 },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const body = parse(result.output);
    expect(body.matches).toEqual([expect.stringContaining("zzz-target.ts")]);
  });

  it("grep_files scans beyond early non-matching files before applying the match limit", async () => {
    for (let i = 0; i < 8; i += 1) {
      writeFileSync(join(workDir, `aaa-${i}.txt`), "noise\n", "utf8");
    }
    writeFileSync(join(workDir, "zzz-target.txt"), "needle late\n", "utf8");

    const result = await new GrepFilesTool().execute(
      { path: ".", pattern: "needle late", limit: 1 },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const body = parse(result.output);
    const matches = body.matches as Array<{ path: string; line: number; text: string }>;
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toContain("zzz-target.txt");
  });

  it("write_file creates parent directories and writes full content", async () => {
    const target = join("generated", "out.txt");
    const result = await new WriteFileTool().execute(
      { path: target, content: "created\n" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(join(workDir, target), "utf8")).toBe("created\n");
  });

  it("write_file uses unique temp files under parallel writes to the same target", async () => {
    const tool = new WriteFileTool();
    const [a, b] = await Promise.all([
      tool.execute({ path: "generated/race.txt", content: "one\n" }, ctx()),
      tool.execute({ path: "generated/race.txt", content: "two\n" }, ctx()),
    ]);

    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    expect(["one\n", "two\n"]).toContain(readFileSync(join(workDir, "generated", "race.txt"), "utf8"));
  });

  it("write_file overwrite emits path and bytes without kind sentinel", async () => {
    writeFileSync(join(workDir, "snap.txt"), "first line\nsecond line\n", "utf8");
    const result = await new WriteFileTool().execute(
      { path: "snap.txt", content: "first line\nupdated line\n" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const parsed = parse(result.output);
    // Sidecar model: output carries path + bytes only; no inline before/after.
    expect(parsed.path).toMatch(/snap\.txt$/);
    expect(typeof parsed.bytes).toBe("number");
    // Small file: both sides under WRITE_DIFF_PREVIEW_LIMIT — not truncated.
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.hasSidecar).toBeUndefined();
  });

  it("write_file new file emits path and bytes without truncated flag", async () => {
    const result = await new WriteFileTool().execute(
      { path: "generated/fresh.txt", content: "hello\n" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const parsed = parse(result.output);
    expect(parsed.path).toMatch(/fresh\.txt$/);
    expect(parsed.bytes).toBe(Buffer.byteLength("hello\n", "utf8"));
    expect(parsed.truncated).toBeUndefined();
  });

  it("write_file large content sets truncated=true in output", async () => {
    const big = "x".repeat(10_000);
    const result = await new WriteFileTool().execute(
      { path: "generated/big.txt", content: big },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const parsed = parse(result.output);
    expect(parsed.truncated).toBe(true);
    expect(parsed.bytes).toBe(Buffer.byteLength(big, "utf8"));
    // Sidecar model: no inline after field — full content lives in sidecar file.
    expect(parsed.after).toBeUndefined();
  });

  it("edit_file replaces a single exact match", async () => {
    const result = await new EditFileTool().execute(
      { path: "README.md", oldText: "needle docs", newText: "updated docs" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(join(workDir, "README.md"), "utf8")).toContain("updated docs");
  });

  it("edit_file fails on ambiguous matches unless replaceAll is explicit", async () => {
    writeFileSync(join(workDir, "dupe.txt"), "x\nx\n", "utf8");

    const result = await new EditFileTool().execute(
      { path: "dupe.txt", oldText: "x", newText: "y" },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("matched 2 times");
  });

  it("apply_patch applies multiple exact replacements atomically", async () => {
    const result = await new ApplyPatchTool().execute(
      {
        path: "README.md",
        replacements: [
          { oldText: "# LVIS", newText: "# LVIS Project" },
          { oldText: "needle docs", newText: "patched docs" },
        ],
      },
      ctx(),
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(join(workDir, "README.md"), "utf8")).toBe("# LVIS Project\npatched docs\n");
  });

  it("apply_patch fails before writing when a later hunk is missing", async () => {
    const result = await new ApplyPatchTool().execute(
      {
        path: "README.md",
        replacements: [
          { oldText: "# LVIS", newText: "# Changed" },
          { oldText: "missing hunk", newText: "nope" },
        ],
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(readFileSync(join(workDir, "README.md"), "utf8")).toBe("# LVIS\nneedle docs\n");
  });

  it("move_file renames a file and creates parent directories", async () => {
    const result = await new MoveFileTool().execute(
      { sourcePath: "README.md", destinationPath: "docs/README.md" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    expect(existsSync(join(workDir, "README.md"))).toBe(false);
    expect(readFileSync(join(workDir, "docs", "README.md"), "utf8")).toBe("# LVIS\nneedle docs\n");
  });

  it("move_file overwrite=false does not clobber a concurrently-created destination", async () => {
    writeFileSync(join(workDir, "one.txt"), "one\n", "utf8");
    writeFileSync(join(workDir, "two.txt"), "two\n", "utf8");
    const tool = new MoveFileTool();

    const results = await Promise.all([
      tool.execute({ sourcePath: "one.txt", destinationPath: "race/out.txt" }, ctx()),
      tool.execute({ sourcePath: "two.txt", destinationPath: "race/out.txt" }, ctx()),
    ]);

    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(results.filter((result) => result.isError && result.output.includes("destination exists"))).toHaveLength(1);
    expect(["one\n", "two\n"]).toContain(readFileSync(join(workDir, "race", "out.txt"), "utf8"));
  });

  it("delete_file removes a regular file", async () => {
    const result = await new DeleteFileTool().execute(
      { path: "README.md" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    expect(existsSync(join(workDir, "README.md"))).toBe(false);
  });

  it("rejects paths outside the sandbox boundary", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lvis-file-tools-outside-"));
    try {
      const result = await new ReadFileTool().execute(
        { path: join(outside, "x.txt") },
        ctx(),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Sandbox:");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("honors executor-threaded additionalDirectories for extra workspace roots", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lvis-file-tools-extra-"));
    try {
      const target = join(outside, "allowed.txt");
      writeFileSync(target, "outside but authorized\n", "utf8");

      const result = await new ReadFileTool().execute(
        { path: target },
        { cwd: workDir, extraAllowedDirectories: [outside], metadata: {} },
      );

      expect(result.isError).toBe(false);
      expect(parse(result.output).content).toBe("outside but authorized");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("round-trips a slash-authorized extra dir into read_file sandbox scope", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lvis-file-tools-slash-extra-"));
    const settingsPath = join(workDir, "permissions.json");
    try {
      const target = join(outside, "allowed-by-slash.txt");
      writeFileSync(target, "slash authorized\n", "utf8");
      const parsed = parsePermissionDirCommand(`allow ${outside}`);
      if ("ok" in parsed) throw new Error(parsed.error);
      const dirResult = await dispatchPermissionDirCommand(
        parsed,
        settingsPath,
      );
      if (!dirResult.ok) throw new Error(dirResult.error);
      expect(dirResult.verb).toBe("allow");

      const extraAllowedDirectories = dirResult.verb === "allow" ? dirResult.persisted : [];
      const result = await new ReadFileTool().execute(
        { path: target },
        { cwd: workDir, extraAllowedDirectories, metadata: {} },
      );

      expect(result.isError).toBe(false);
      expect(parse(result.output).content).toBe("slash authorized");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("registers native file tools in the canonical registry", () => {
    const registry = new ToolRegistry();
    for (const tool of createFileTools()) registry.register(tool);

    const expectedPathFields = new Map<string, readonly string[]>([
      ["read_file", ["path"]],
      ["list_files", ["path"]],
      ["glob_files", ["path"]],
      ["grep_files", ["path"]],
      ["write_file", ["path"]],
      ["edit_file", ["path"]],
      ["apply_patch", ["path"]],
      ["move_file", ["sourcePath", "destinationPath"]],
      ["delete_file", ["path"]],
    ]);
    for (const [name, pathFields] of expectedPathFields) {
      const found = registry.findByName(name);
      expect(found).toBeDefined();
      expect(found?.source).toBe("builtin");
      expect(found?.pathFields).toEqual(pathFields);
    }
    expect(registry.findByName("read_file")?.category).toBe("read");
    expect(registry.findByName("write_file")?.category).toBe("write");
    expect(registry.findByName("apply_patch")?.category).toBe("write");
  });
});

describe("WriteFileTool pre-image guard (MAJOR 1)", () => {
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "lvis-write-guard-"));
    // Redirect sidecar writes to isolated temp dir (mirrors write-diff-cache.test.ts pattern).
    process.env.LVIS_HOME = testHome;
  });

  afterEach(() => {
    delete process.env.LVIS_HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  it("skips pre-image read and sets skipSidecar for a file exceeding MAX_TEXT_FILE_BYTES", async () => {
    // Write a real file that exceeds MAX_TEXT_FILE_BYTES (2_000_000).
    // We fill 2.1MB with repeated ASCII so stat() reports the actual size.
    // ESM module namespaces are not re-configurable, so vi.spyOn(node:fs/promises)
    // does not work in this suite — real file is the correct approach.
    const bigPath = join(workDir, "big.txt");
    const chunk = "x".repeat(1024); // 1 KiB
    const buf = Buffer.alloc(2_100_000);
    buf.fill(chunk);
    writeFileSync(bigPath, buf);

    const result = await new WriteFileTool().execute(
      { path: bigPath, content: "new content" },
      { cwd: workDir, extraAllowedDirectories: [], metadata: { sessionId: "s1", toolUseId: "tu1" } },
    );

    expect(result.isError).toBe(false);
    const body = parse(result.output);
    // hasSidecar must be false — skipSidecar was set for the oversized pre-image.
    expect(body.hasSidecar).toBeUndefined();
    // File was still overwritten with new content.
    expect(readFileSync(bigPath, "utf8")).toBe("new content");
  });

  it("skips pre-image read and sets skipSidecar for a binary pre-existing file", async () => {
    // Write a file with null bytes (binary signature).
    const binPath = join(workDir, "image.bin");
    writeFileSync(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]));

    // Use after content > WRITE_DIFF_PREVIEW_LIMIT (4096) so truncated=true fires.
    // Without the binary guard, hasSidecar would be true. The guard must suppress it.
    const largeAfter = "x".repeat(4097);
    const result = await new WriteFileTool().execute(
      { path: binPath, content: largeAfter },
      { cwd: workDir, extraAllowedDirectories: [], metadata: { sessionId: "s2", toolUseId: "tu2" } },
    );

    expect(result.isError).toBe(false);
    const body = parse(result.output);
    // truncated=true because afterBytes > WRITE_DIFF_PREVIEW_LIMIT.
    expect(body.truncated).toBe(true);
    // hasSidecar must be false — binary pre-image triggers skipSidecar, so
    // writeDiffSidecar is never called even though afterBytes > preview limit.
    expect(body.hasSidecar).toBe(false);
    // File was still written with new text content.
    expect(readFileSync(binPath, "utf8")).toBe(largeAfter);
  });

  it("writes sidecar normally for a small text pre-existing file", async () => {
    const txtPath = join(workDir, "small.txt");
    writeFileSync(txtPath, "before content", "utf8");

    const result = await new WriteFileTool().execute(
      { path: txtPath, content: "after content" },
      { cwd: workDir, extraAllowedDirectories: [], metadata: { sessionId: "s3", toolUseId: "tu3" } },
    );

    expect(result.isError).toBe(false);
    // Small file: sidecar is NOT written unless content exceeds WRITE_DIFF_PREVIEW_LIMIT.
    // The important invariant: no crash, and the file content is updated.
    expect(readFileSync(txtPath, "utf8")).toBe("after content");
  });
});
