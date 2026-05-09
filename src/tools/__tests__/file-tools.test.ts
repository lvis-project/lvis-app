import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry } from "../registry.js";
import {
  createFileTools,
  EditFileTool,
  GlobFilesTool,
  GrepFilesTool,
  ListFilesTool,
  ReadFileTool,
  WriteFileTool,
} from "../file-tools.js";
import type { ToolExecutionContext } from "../base.js";

let workDir: string;

function ctx(): ToolExecutionContext {
  return { cwd: workDir, metadata: {} };
}

function parse(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
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
    expect(matches.some((p) => p.endsWith("src/a.ts"))).toBe(true);
    expect(matches.some((p) => p.endsWith("src/nested/b.ts"))).toBe(true);
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

  it("write_file creates parent directories and writes full content", async () => {
    const target = join("generated", "out.txt");
    const result = await new WriteFileTool().execute(
      { path: target, content: "created\n" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(join(workDir, target), "utf8")).toBe("created\n");
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

  it("registers first-phase tools in the canonical registry", () => {
    const registry = new ToolRegistry();
    for (const tool of createFileTools()) registry.register(tool);

    for (const name of [
      "read_file",
      "list_files",
      "glob_files",
      "grep_files",
      "write_file",
      "edit_file",
    ]) {
      const found = registry.findByName(name);
      expect(found).toBeDefined();
      expect(found?.source).toBe("builtin");
      expect(found?.pathFields).toEqual(["path"]);
    }
    expect(registry.findByName("read_file")?.category).toBe("read");
    expect(registry.findByName("write_file")?.category).toBe("write");
  });
});
