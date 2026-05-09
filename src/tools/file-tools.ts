import { createReadStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as pathResolve,
  sep,
} from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

import { validateSandboxPath } from "../sandbox/path-validator.js";
import {
  ZodTool,
  type Tool,
  type ToolCategory,
  type ToolExecutionContext,
  type ToolResult,
} from "./base.js";

type ToolErrorResult = ToolResult & { isError: true };
type Result<T> = { ok: true; value: T } | { ok: false; error: ToolErrorResult };

const DEFAULT_LINE_LIMIT = 2_000;
const MAX_LINE_LIMIT = 5_000;
const MAX_TEXT_FILE_BYTES = 2_000_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const BINARY_SAMPLE_BYTES = 8_192;
const DEFAULT_RESULT_LIMIT = 200;
const MAX_RESULT_LIMIT = 1_000;
const DEFAULT_LIST_DEPTH = 1;
const MAX_LIST_DEPTH = 8;
const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

const FilePathSchema = z.object({
  path: z.string().min(1).describe("Absolute path or path relative to the session cwd."),
});

export const ReadFileInputSchema = FilePathSchema.extend({
  offset: z.number().int().min(0).default(0).describe("Zero-based line offset."),
  limit: z.number().int().min(1).max(MAX_LINE_LIMIT).default(DEFAULT_LINE_LIMIT),
});

export const ListFilesInputSchema = FilePathSchema.extend({
  depth: z.number().int().min(1).max(MAX_LIST_DEPTH).default(DEFAULT_LIST_DEPTH),
  limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
});

export const GlobFilesInputSchema = z.object({
  pattern: z.string().min(1).describe("Glob pattern relative to path/cwd, e.g. src/**/*.ts."),
  path: z.string().min(1).optional().describe("Search root. Defaults to session cwd."),
  limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
});

export const GrepFilesInputSchema = z.object({
  pattern: z.string().min(1).describe("JavaScript regular expression."),
  path: z.string().min(1).optional().describe("Search root. Defaults to session cwd."),
  include: z.string().min(1).optional().describe("Optional glob include filter, e.g. **/*.ts."),
  caseSensitive: z.boolean().default(true),
  limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
});

export const WriteFileInputSchema = FilePathSchema.extend({
  content: z.string().describe("Full file content to write."),
});

export const EditFileInputSchema = FilePathSchema.extend({
  oldText: z.string().min(1).describe("Exact text to replace."),
  newText: z.string().describe("Replacement text."),
  replaceAll: z.boolean().default(false),
});

export const ApplyPatchInputSchema = FilePathSchema.extend({
  replacements: z.array(z.object({
    oldText: z.string().min(1).describe("Exact text to replace."),
    newText: z.string().describe("Replacement text."),
    replaceAll: z.boolean().default(false),
  })).min(1).max(50),
});

export const MoveFileInputSchema = z.object({
  sourcePath: z.string().min(1).describe("Source file path, absolute or relative to session cwd."),
  destinationPath: z.string().min(1).describe("Destination file path, absolute or relative to session cwd."),
  overwrite: z.boolean().default(false),
});

export const DeleteFileInputSchema = FilePathSchema.extend({});

abstract class FileTool<TSchema extends z.ZodTypeAny> extends ZodTool<TSchema> {
  override readonly source = "builtin" as const;
  readonly pathFields: readonly string[] = ["path"];

  protected resolvePath(inputPath: string, ctx: ToolExecutionContext): string {
    const expanded = expandTilde(inputPath);
    return isAbsolute(expanded) ? pathResolve(expanded) : pathResolve(ctx.cwd, expanded);
  }

  protected ensureAllowed(path: string, ctx: ToolExecutionContext): ToolResult | null {
    const check = validateSandboxPath(path, ctx.cwd);
    if (!check.allowed) {
      return toolError(`Sandbox: ${check.reason}`);
    }
    return null;
  }
}

export class ReadFileTool extends FileTool<typeof ReadFileInputSchema> {
  readonly name = "read_file";
  readonly description =
    "Read a UTF-8 text file from the workspace. Supports zero-based line offset and line limit for large files.";
  readonly inputSchema = ReadFileInputSchema;
  override readonly category: ToolCategory = "read";

  override isReadOnly(): boolean {
    return true;
  }

  protected async executeTyped(
    input: z.infer<typeof ReadFileInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const target = this.resolvePath(input.path, ctx);
    const blocked = this.ensureAllowed(target, ctx);
    if (blocked) return blocked;

    const fileStat = await statFile(target);
    if (!fileStat.ok) return fileStat.error;
    if (!fileStat.value.isFile()) {
      return toolError(`read_file requires a regular file: ${target}`);
    }
    if (await isBinaryFile(target)) {
      return toolError(`read_file refused binary file: ${target}`);
    }

    const window = await readLineWindow(target, input.offset, input.limit);
    return {
      output: JSON.stringify({
        path: target,
        startLine: input.offset + 1,
        endLine: input.offset + window.lines.length,
        truncated: window.truncated,
        content: window.lines.join("\n"),
      }),
      isError: false,
      metadata: {
        path: target,
        truncated: window.truncated,
        lineCount: window.lines.length,
      },
    };
  }
}

export class ListFilesTool extends FileTool<typeof ListFilesInputSchema> {
  readonly name = "list_files";
  readonly description =
    "List files and directories under a workspace path. Returns bounded, depth-limited entries.";
  readonly inputSchema = ListFilesInputSchema;
  override readonly category: ToolCategory = "read";

  override isReadOnly(): boolean {
    return true;
  }

  protected async executeTyped(
    input: z.infer<typeof ListFilesInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const root = this.resolvePath(input.path, ctx);
    const blocked = this.ensureAllowed(root, ctx);
    if (blocked) return blocked;

    const listed = await listEntries(root, input.depth, input.limit);
    if (!listed.ok) return listed.error;
    return {
      output: JSON.stringify({
        path: root,
        entries: listed.value.entries,
        truncated: listed.value.truncated,
      }),
      isError: false,
      metadata: { path: root, truncated: listed.value.truncated },
    };
  }
}

export class GlobFilesTool extends FileTool<typeof GlobFilesInputSchema> {
  readonly name = "glob_files";
  readonly description =
    "Find files by glob pattern under the workspace. Searches paths, not file contents.";
  readonly inputSchema = GlobFilesInputSchema;
  override readonly category: ToolCategory = "read";

  override isReadOnly(): boolean {
    return true;
  }

  protected async executeTyped(
    input: z.infer<typeof GlobFilesInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const root = this.resolvePath(input.path ?? ".", ctx);
    const blocked = this.ensureAllowed(root, ctx);
    if (blocked) return blocked;

    const regex = globToRegExp(input.pattern);
    const listed = await collectFiles(root, input.limit);
    if (!listed.ok) return listed.error;
    const matches = listed.value.files
      .filter((entry) => regex.test(entry.relativePath))
      .map((entry) => entry.path);
    return {
      output: JSON.stringify({
        path: root,
        pattern: input.pattern,
        matches,
        truncated: listed.value.truncated,
      }),
      isError: false,
      metadata: { path: root, pattern: input.pattern, matchCount: matches.length },
    };
  }
}

export class GrepFilesTool extends FileTool<typeof GrepFilesInputSchema> {
  readonly name = "grep_files";
  readonly description =
    "Search UTF-8 text files by JavaScript regular expression. Returns bounded file/line matches.";
  readonly inputSchema = GrepFilesInputSchema;
  override readonly category: ToolCategory = "read";

  override isReadOnly(): boolean {
    return true;
  }

  protected async executeTyped(
    input: z.infer<typeof GrepFilesInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const root = this.resolvePath(input.path ?? ".", ctx);
    const blocked = this.ensureAllowed(root, ctx);
    if (blocked) return blocked;

    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.caseSensitive ? "" : "i");
    } catch (err) {
      return { output: `Invalid regex: ${(err as Error).message}`, isError: true };
    }

    const include = input.include ? globToRegExp(input.include) : null;
    const listed = await collectFiles(root, input.limit * 20);
    if (!listed.ok) return listed.error;

    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const file of listed.value.files) {
      if (include && !include.test(file.relativePath)) continue;
      if (matches.length >= input.limit) break;
      const maybeMatches = await grepFile(file.path, regex, input.limit - matches.length);
      if (!maybeMatches.ok) continue;
      matches.push(...maybeMatches.value);
    }

    return {
      output: JSON.stringify({
        path: root,
        pattern: input.pattern,
        include: input.include,
        matches,
        truncated: matches.length >= input.limit || listed.value.truncated,
      }),
      isError: false,
      metadata: { path: root, matchCount: matches.length },
    };
  }
}

export class WriteFileTool extends FileTool<typeof WriteFileInputSchema> {
  readonly name = "write_file";
  readonly description =
    "Create or overwrite a UTF-8 text file. Parent directories are created automatically.";
  readonly inputSchema = WriteFileInputSchema;
  override readonly category: ToolCategory = "write";

  protected async executeTyped(
    input: z.infer<typeof WriteFileInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const target = this.resolvePath(input.path, ctx);
    const blocked = this.ensureAllowed(target, ctx);
    if (blocked) return blocked;

    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.lvis-tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, input.content, "utf8");
    await rename(temp, target);
    return {
      output: JSON.stringify({ path: target, bytes: Buffer.byteLength(input.content, "utf8") }),
      isError: false,
      metadata: { path: target },
    };
  }
}

export class EditFileTool extends FileTool<typeof EditFileInputSchema> {
  readonly name = "edit_file";
  readonly description =
    "Replace exact text in an existing UTF-8 file. Fails when the match is missing or ambiguous.";
  readonly inputSchema = EditFileInputSchema;
  override readonly category: ToolCategory = "write";

  protected async executeTyped(
    input: z.infer<typeof EditFileInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const target = this.resolvePath(input.path, ctx);
    const blocked = this.ensureAllowed(target, ctx);
    if (blocked) return blocked;

    const fileStat = await statFile(target);
    if (!fileStat.ok) return fileStat.error;
    if (!fileStat.value.isFile()) {
      return toolError(`edit_file requires a regular file: ${target}`);
    }
    if (fileStat.value.size > MAX_TEXT_FILE_BYTES) {
      return toolError(`edit_file refused large file > ${MAX_TEXT_FILE_BYTES} bytes: ${target}`);
    }
    if (await isBinaryFile(target)) {
      return toolError(`edit_file refused binary file: ${target}`);
    }

    const current = await readFile(target, "utf8");
    const occurrences = countOccurrences(current, input.oldText);
    if (occurrences === 0) {
      return toolError(`edit_file oldText not found in ${target}`);
    }
    if (occurrences > 1 && !input.replaceAll) {
      return {
        output: `edit_file oldText matched ${occurrences} times in ${target}; set replaceAll=true for intentional global replacement`,
        isError: true,
      };
    }

    const next = input.replaceAll
      ? current.split(input.oldText).join(input.newText)
      : current.replace(input.oldText, input.newText);
    const temp = `${target}.lvis-tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, next, "utf8");
    await rename(temp, target);
    return {
      output: JSON.stringify({ path: target, replacements: input.replaceAll ? occurrences : 1 }),
      isError: false,
      metadata: { path: target, replacements: input.replaceAll ? occurrences : 1 },
    };
  }
}

export class ApplyPatchTool extends FileTool<typeof ApplyPatchInputSchema> {
  readonly name = "apply_patch";
  readonly description =
    "Apply one or more exact text replacements to an existing UTF-8 file. Fails before writing when any hunk is missing or ambiguous.";
  readonly inputSchema = ApplyPatchInputSchema;
  override readonly category: ToolCategory = "write";

  protected async executeTyped(
    input: z.infer<typeof ApplyPatchInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const target = this.resolvePath(input.path, ctx);
    const blocked = this.ensureAllowed(target, ctx);
    if (blocked) return blocked;

    const fileStat = await statFile(target);
    if (!fileStat.ok) return fileStat.error;
    if (!fileStat.value.isFile()) {
      return toolError(`apply_patch requires a regular file: ${target}`);
    }
    if (fileStat.value.size > MAX_TEXT_FILE_BYTES) {
      return toolError(`apply_patch refused large file > ${MAX_TEXT_FILE_BYTES} bytes: ${target}`);
    }
    if (await isBinaryFile(target)) {
      return toolError(`apply_patch refused binary file: ${target}`);
    }

    let next = await readFile(target, "utf8");
    let totalReplacements = 0;
    for (const replacement of input.replacements) {
      const occurrences = countOccurrences(next, replacement.oldText);
      if (occurrences === 0) {
        return toolError(`apply_patch oldText not found in ${target}`);
      }
      if (occurrences > 1 && !replacement.replaceAll) {
        return toolError(
          `apply_patch oldText matched ${occurrences} times in ${target}; set replaceAll=true for intentional global replacement`,
        );
      }
      totalReplacements += replacement.replaceAll ? occurrences : 1;
      next = replacement.replaceAll
        ? next.split(replacement.oldText).join(replacement.newText)
        : next.replace(replacement.oldText, replacement.newText);
    }

    const temp = `${target}.lvis-tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, next, "utf8");
    await rename(temp, target);
    return {
      output: JSON.stringify({ path: target, replacements: totalReplacements }),
      isError: false,
      metadata: { path: target, replacements: totalReplacements },
    };
  }
}

export class MoveFileTool extends FileTool<typeof MoveFileInputSchema> {
  readonly name = "move_file";
  readonly description =
    "Move or rename a regular file within the workspace. Parent directories are created automatically.";
  readonly inputSchema = MoveFileInputSchema;
  override readonly category: ToolCategory = "write";
  override readonly pathFields = ["sourcePath", "destinationPath"] as const;

  protected async executeTyped(
    input: z.infer<typeof MoveFileInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const source = this.resolvePath(input.sourcePath, ctx);
    const destination = this.resolvePath(input.destinationPath, ctx);
    const sourceBlocked = this.ensureAllowed(source, ctx);
    if (sourceBlocked) return sourceBlocked;
    const destinationBlocked = this.ensureAllowed(destination, ctx);
    if (destinationBlocked) return destinationBlocked;

    const sourceStat = await statFile(source);
    if (!sourceStat.ok) return sourceStat.error;
    if (!sourceStat.value.isFile()) {
      return toolError(`move_file requires a regular source file: ${source}`);
    }
    const destinationStat = await statExistingPath(destination);
    if (!destinationStat.ok) return destinationStat.error;
    if (destinationStat.value && !input.overwrite) {
      return toolError(`move_file destination exists; set overwrite=true to replace: ${destination}`);
    }
    if (destinationStat.value && !destinationStat.value.isFile()) {
      return toolError(`move_file destination is not a regular file: ${destination}`);
    }

    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
    return {
      output: JSON.stringify({ sourcePath: source, destinationPath: destination }),
      isError: false,
      metadata: { sourcePath: source, destinationPath: destination },
    };
  }
}

export class DeleteFileTool extends FileTool<typeof DeleteFileInputSchema> {
  readonly name = "delete_file";
  readonly description = "Delete a regular file from the workspace.";
  readonly inputSchema = DeleteFileInputSchema;
  override readonly category: ToolCategory = "write";

  protected async executeTyped(
    input: z.infer<typeof DeleteFileInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const target = this.resolvePath(input.path, ctx);
    const blocked = this.ensureAllowed(target, ctx);
    if (blocked) return blocked;

    const fileStat = await statFile(target);
    if (!fileStat.ok) return fileStat.error;
    if (!fileStat.value.isFile()) {
      return toolError(`delete_file requires a regular file: ${target}`);
    }
    await unlink(target);
    return {
      output: JSON.stringify({ path: target, deleted: true }),
      isError: false,
      metadata: { path: target, deleted: true },
    };
  }
}

export function createFileTools(): Tool[] {
  return [
    new ReadFileTool(),
    new ListFilesTool(),
    new GlobFilesTool(),
    new GrepFilesTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new ApplyPatchTool(),
    new MoveFileTool(),
    new DeleteFileTool(),
  ];
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

async function statFile(path: string): Promise<
  Result<Awaited<ReturnType<typeof stat>>>
> {
  try {
    return { ok: true, value: await stat(path) };
  } catch (err) {
    return { ok: false, error: toolError(`File stat failed: ${(err as Error).message}`) };
  }
}

async function statExistingPath(path: string): Promise<
  Result<Awaited<ReturnType<typeof stat>> | null>
> {
  try {
    return { ok: true, value: await stat(path) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, value: null };
    }
    return { ok: false, error: toolError(`File stat failed: ${(err as Error).message}`) };
  }
}

async function isBinaryFile(path: string): Promise<boolean> {
  const stream = createReadStream(path, { start: 0, end: BINARY_SAMPLE_BYTES - 1 });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).includes(0);
}

async function readLineWindow(
  path: string,
  offset: number,
  limit: number,
): Promise<{ lines: string[]; truncated: boolean }> {
  const input = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const lines: string[] = [];
  let lineNo = 0;
  let truncated = false;

  for await (const line of rl) {
    if (lineNo >= offset && lines.length < limit) {
      lines.push(line);
    } else if (lineNo >= offset && lines.length >= limit) {
      truncated = true;
      break;
    }
    lineNo += 1;
  }
  rl.close();
  input.destroy();
  return { lines, truncated };
}

interface ListedEntry {
  path: string;
  relativePath: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
  mtimeMs?: number;
}

async function listEntries(
  root: string,
  depth: number,
  limit: number,
): Promise<Result<{ entries: ListedEntry[]; truncated: boolean }>> {
  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      return { ok: false, error: toolError(`list_files requires a directory: ${root}`) };
    }
    const entries: ListedEntry[] = [];
    await walk(root, root, depth, limit, entries, { filesOnly: false });
    return { ok: true, value: { entries, truncated: entries.length >= limit } };
  } catch (err) {
    return { ok: false, error: toolError(`list_files failed: ${(err as Error).message}`) };
  }
}

async function collectFiles(
  root: string,
  limit: number,
): Promise<Result<{ files: ListedEntry[]; truncated: boolean }>> {
  try {
    const rootStat = await stat(root);
    const files: ListedEntry[] = [];
    if (rootStat.isFile()) {
      files.push({
        path: root,
        relativePath: root.split(sep).pop() ?? root,
        type: "file",
        size: rootStat.size,
        mtimeMs: rootStat.mtimeMs,
      });
    } else if (rootStat.isDirectory()) {
      await walk(root, root, MAX_LIST_DEPTH, limit, files, { filesOnly: true });
    } else {
      return { ok: false, error: toolError(`file search requires a file or directory: ${root}`) };
    }
    return { ok: true, value: { files, truncated: files.length >= limit } };
  } catch (err) {
    return { ok: false, error: toolError(`file search failed: ${(err as Error).message}`) };
  }
}

async function walk(
  root: string,
  current: string,
  remainingDepth: number,
  limit: number,
  output: ListedEntry[],
  opts: { filesOnly: boolean },
): Promise<void> {
  if (output.length >= limit || remainingDepth < 1) return;
  const dirents = await readdir(current, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name));
  for (const dirent of dirents) {
    if (output.length >= limit) return;
    const full = join(current, dirent.name);
    const rel = normalizeRelativePath(relative(root, full));
    const type = dirent.isDirectory()
      ? "directory"
      : dirent.isFile()
        ? "file"
        : dirent.isSymbolicLink()
          ? "symlink"
          : "other";
    if (!opts.filesOnly || type === "file") {
      const entryStat = type === "file" ? await stat(full) : null;
      output.push({
        path: full,
        relativePath: rel,
        type,
        ...(entryStat ? { size: entryStat.size, mtimeMs: entryStat.mtimeMs } : {}),
      });
    }
    if (dirent.isDirectory() && remainingDepth > 1 && !DEFAULT_SKIP_DIRS.has(dirent.name)) {
      await walk(root, full, remainingDepth - 1, limit, output, opts);
    }
  }
}

async function grepFile(
  path: string,
  regex: RegExp,
  limit: number,
): Promise<Result<Array<{ path: string; line: number; text: string }>>> {
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size > MAX_SEARCH_FILE_BYTES) {
    return { ok: true, value: [] };
  }
  if (await isBinaryFile(path)) {
    return { ok: true, value: [] };
  }
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const input = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let lineNo = 1;
  for await (const line of rl) {
    regex.lastIndex = 0;
    if (regex.test(line)) {
      matches.push({ path, line: lineNo, text: line });
      if (matches.length >= limit) break;
    }
    lineNo += 1;
  }
  rl.close();
  input.destroy();
  return { ok: true, value: matches };
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let out = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    const next = normalized[i + 1];
    if (ch === "*" && next === "*") {
      if (normalized[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += escapeRegex(ch);
  }
  return new RegExp(`${out}$`);
}

function escapeRegex(ch: string): string {
  return /[\\^$+?.()|[\]{}]/.test(ch) ? `\\${ch}` : ch;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

function toolError(output: string): ToolErrorResult {
  return { output, isError: true };
}
