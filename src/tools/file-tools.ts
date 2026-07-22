import { constants, createReadStream, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as pathResolve,
  sep,
} from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { z } from "zod";

import { validateSandboxPath } from "../sandbox/path-validator.js";
import {
  MAX_TEXT_FILE_BYTES,
  expandTilde,
  isBinaryFile,
  readTextFileWindow,
} from "./file-read-core.js";
import { globToRegExp } from "../lib/glob-matcher.js";
import { writeDiffSidecar, WRITE_DIFF_PREVIEW_LIMIT } from "./write-diff-cache.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../permissions/sensitive-paths.js";
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
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const DEFAULT_RESULT_LIMIT = 200;
const MAX_RESULT_LIMIT = 1_000;
const MAX_SCAN_FILES = 50_000;
const MAX_SCAN_ENTRIES = 75_000;
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
    const sensitive = sensitivePatternForPath(path);
    if (sensitive) {
      return toolError(`Sensitive path: ${path} matches ${sensitive}`);
    }
    const check = validateSandboxPath(path, ctx.cwd, [...ctx.extraAllowedDirectories]);
    if (!check.allowed) {
      return toolError(`Sandbox: ${check.reason}`);
    }
    return null;
  }

  protected resolveApprovalPath(inputPath: string, ctx: Pick<ToolExecutionContext, "cwd"> | undefined): string {
    if (!ctx?.cwd) {
      throw new Error(`${this.name} approvalCacheKey requires explicit cwd`);
    }
    const expanded = expandTilde(inputPath);
    return isAbsolute(expanded) ? pathResolve(expanded) : pathResolve(ctx.cwd, expanded);
  }

  protected requireStringField(input: unknown, field: string): string {
    if (!input || typeof input !== "object") {
      throw new Error(`${this.name} approvalCacheKey requires object input`);
    }
    const value = (input as Record<string, unknown>)[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${this.name} approvalCacheKey requires '${field}' string`);
    }
    return value;
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

    const window = await readTextFileWindow(target, input.offset, input.limit);
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

/** Per-image byte ceiling — Anthropic rejects images larger than 5 MB. */
const VIEW_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Sniff a supported raster image type by magic bytes (the Anthropic-accepted
 * set). Returns the IANA media type or null when the bytes are not one of them —
 * we never trust the file extension for a payload the model will see.
 */
function detectImageMime(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export const ViewImageInputSchema = FilePathSchema;

/**
 * `view_image` — load a local image file into the model's context so it can see
 * it. Reuses the same path-scope security as read_file (resolvePath +
 * ensureAllowed). The image rides {@link ToolResult.image}; the text `output` is
 * a placeholder, and the message mapper turns the image into a visible block on
 * Claude (dropped to the placeholder on vendors whose tool results are text-only).
 */
export class ViewImageTool extends FileTool<typeof ViewImageInputSchema> {
  readonly name = "view_image";
  readonly description =
    "Load a local image file (png, jpeg, gif, or webp, max 5 MB) into your context so you can see " +
    "it. Give the file path; the image is returned to you visually. Use this when you need to look " +
    "at a screenshot, diagram, or picture on disk.";
  readonly inputSchema = ViewImageInputSchema;
  override readonly category: ToolCategory = "read";

  override isReadOnly(): boolean {
    return true;
  }

  protected async executeTyped(
    input: z.infer<typeof ViewImageInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const target = this.resolvePath(input.path, ctx);
    const blocked = this.ensureAllowed(target, ctx);
    if (blocked) return blocked;

    const fileStat = await statFile(target);
    if (!fileStat.ok) return fileStat.error;
    if (!fileStat.value.isFile()) {
      return toolError(`view_image requires a regular file: ${target}`);
    }
    if (fileStat.value.size > VIEW_IMAGE_MAX_BYTES) {
      return toolError(
        `view_image: image is ${fileStat.value.size} bytes, over the ${VIEW_IMAGE_MAX_BYTES}-byte (5 MB) limit: ${target}`,
      );
    }

    const buf = await readFile(target);
    const mimeType = detectImageMime(buf);
    if (mimeType === null) {
      return toolError(`view_image: not a supported image (png, jpeg, gif, webp): ${target}`);
    }

    return {
      output: JSON.stringify({ path: target, mimeType, bytes: buf.length, loaded: true }),
      isError: false,
      image: { data: buf.toString("base64"), mimeType, bytes: buf.length },
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
    const listed = await collectFiles(root, MAX_SCAN_FILES);
    if (!listed.ok) return listed.error;
    const allMatches = listed.value.files
      .filter((entry) => regex.test(entry.relativePath))
      .map((entry) => entry.path);
    const matches = allMatches.slice(0, input.limit);
    return {
      output: JSON.stringify({
        path: root,
        pattern: input.pattern,
        matches,
        truncated: listed.value.truncated || allMatches.length > input.limit,
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
    const listed = await collectFiles(root, MAX_SCAN_FILES);
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

  approvalCacheKey(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): string {
    return `path:${this.resolveApprovalPath(this.requireStringField(input, "path"), ctx)}`;
  }

  protected async executeTyped(
    input: z.infer<typeof WriteFileInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const target = this.resolvePath(input.path, ctx);
    const blocked = this.ensureAllowed(target, ctx);
    if (blocked) return blocked;

    // Read existing content for diff sidecar (best-effort — missing file = empty before).
    // Guard: skip pre-image read for large or binary files to avoid OOM / mojibake.
    // Mirrors the EditFileTool / ApplyPatchTool pattern exactly.
    let before = "";
    let skipSidecar = false;
    // Open the file once and bind stat + read to the same inode handle to
    // eliminate the TOCTOU window between stat() and readFile().
    const fh = await open(target, "r").catch(() => null);
    if (fh !== null) {
      try {
        const fhStat = await fh.stat();
        if (fhStat.size > MAX_TEXT_FILE_BYTES) {
          skipSidecar = true;
        } else {
          // Size verified ≤ MAX_TEXT_FILE_BYTES on this exact handle.
          // A concurrent truncate between fh.stat() and fh.readFile() can
          // shrink the read result but cannot grow it past the cap, so the
          // OOM bound holds — the file descriptor binds the inode, not the
          // data length.
          before = await fh.readFile("utf8");
        }
      } finally {
        await fh.close();
      }
      // isBinaryFile reopens the file internally but is bounded by its own
      // limit; acceptable as a secondary guard after the size check passes.
      if (!skipSidecar && (await isBinaryFile(target))) {
        skipSidecar = true;
        before = "";
      }
    }
    const after = input.content;

    await mkdir(dirname(target), { recursive: true });
    await atomicTextWrite(target, after);

    // Write diff sidecar when either side exceeds the preview limit.
    const sessionId =
      typeof ctx.metadata?.sessionId === "string" ? ctx.metadata.sessionId : "";
    const toolUseId =
      typeof ctx.metadata?.toolUseId === "string" ? ctx.metadata.toolUseId : "";
    let hasSidecar = false;
    if (!skipSidecar && sessionId && toolUseId) {
      // writeDiffSidecar logs failures internally via its own createLogger.
      // auditWarn callback is a no-op here; failures keep truncated state
      // visible in the UI without a silent fallback.
      hasSidecar = await writeDiffSidecar(sessionId, toolUseId, before, after, () => {});
    }

    const beforeBytes = Buffer.byteLength(before, "utf8");
    const afterBytes = Buffer.byteLength(after, "utf8");
    const truncated =
      beforeBytes > WRITE_DIFF_PREVIEW_LIMIT || afterBytes > WRITE_DIFF_PREVIEW_LIMIT;

    return {
      output: JSON.stringify({
        path: target,
        bytes: afterBytes,
        ...(truncated ? { truncated: true, hasSidecar } : {}),
      }),
      isError: false,
      metadata: { path: target, ...(truncated ? { truncated: true, hasSidecar } : {}) },
    };
  }
}

export class EditFileTool extends FileTool<typeof EditFileInputSchema> {
  readonly name = "edit_file";
  readonly description =
    "Replace exact text in an existing UTF-8 file. Fails when the match is missing or ambiguous.";
  readonly inputSchema = EditFileInputSchema;
  override readonly category: ToolCategory = "write";

  approvalCacheKey(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): string {
    return `path:${this.resolveApprovalPath(this.requireStringField(input, "path"), ctx)}`;
  }

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
    await atomicTextWrite(target, next);
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

  approvalCacheKey(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): string {
    return `path:${this.resolveApprovalPath(this.requireStringField(input, "path"), ctx)}`;
  }

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

    await atomicTextWrite(target, next);
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

  approvalCacheKey(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): string {
    const source = this.resolveApprovalPath(this.requireStringField(input, "sourcePath"), ctx);
    const destination = this.resolveApprovalPath(this.requireStringField(input, "destinationPath"), ctx);
    return `source:${source}:destination:${destination}`;
  }

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
    await mkdir(dirname(destination), { recursive: true });
    if (input.overwrite) {
      const destinationStat = await statExistingPath(destination);
      if (!destinationStat.ok) return destinationStat.error;
      if (destinationStat.value && !destinationStat.value.isFile()) {
        return toolError(`move_file destination is not a regular file: ${destination}`);
      }
      await rename(source, destination);
    } else {
      const moved = await noClobberMoveFile(source, destination);
      if (!moved.ok) return moved.error;
    }
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

  approvalCacheKey(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): string {
    return `path:${this.resolveApprovalPath(this.requireStringField(input, "path"), ctx)}`;
  }

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
    new ViewImageTool(),
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

function sensitivePatternForPath(path: string): string | null {
  return isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(path)));
}

async function statFile(path: string): Promise<Result<Stats>> {
  try {
    return { ok: true, value: await stat(path) };
  } catch (err) {
    return { ok: false, error: toolError(`File stat failed: ${(err as Error).message}`) };
  }
}

async function statExistingPath(path: string): Promise<Result<Stats | null>> {
  try {
    return { ok: true, value: await stat(path) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, value: null };
    }
    return { ok: false, error: toolError(`File stat failed: ${(err as Error).message}`) };
  }
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
    const state = { visited: 0, truncated: false };
    await walk(root, root, depth, limit, entries, { filesOnly: false }, state);
    const truncated = entries.length >= limit || state.truncated;
    return { ok: true, value: { entries, truncated } };
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
    const state = { visited: 0, truncated: false };
    if (sensitivePatternForPath(root)) {
      return { ok: true, value: { files, truncated: false } };
    }
    if (rootStat.isFile()) {
      files.push({
        path: root,
        relativePath: root.split(sep).pop() ?? root,
        type: "file",
        size: rootStat.size,
        mtimeMs: rootStat.mtimeMs,
      });
    } else if (rootStat.isDirectory()) {
      await walk(root, root, MAX_LIST_DEPTH, limit, files, { filesOnly: true }, state);
    } else {
      return { ok: false, error: toolError(`file search requires a file or directory: ${root}`) };
    }
    return { ok: true, value: { files, truncated: files.length >= limit || state.truncated } };
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
  state: { visited: number; truncated: boolean },
): Promise<void> {
  if (output.length >= limit || remainingDepth < 1 || state.truncated) return;
  const dirents = await readdir(current, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name));
  for (const dirent of dirents) {
    if (output.length >= limit || state.truncated) return;
    state.visited += 1;
    if (state.visited > MAX_SCAN_ENTRIES) {
      state.truncated = true;
      return;
    }
    const full = join(current, dirent.name);
    if (sensitivePatternForPath(full)) {
      continue;
    }
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
      await walk(root, full, remainingDepth - 1, limit, output, opts, state);
    }
  }
}

async function noClobberMoveFile(source: string, destination: string): Promise<Result<null>> {
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await unlink(source);
    return { ok: true, value: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return { ok: false, error: toolError(`move_file destination exists; set overwrite=true to replace: ${destination}`) };
    }
    return { ok: false, error: toolError(`move_file failed: ${(err as Error).message}`) };
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
  try {
    for await (const line of rl) {
      regex.lastIndex = 0;
      if (regex.test(line)) {
        matches.push({ path, line: lineNo, text: line });
        if (matches.length >= limit) break;
      }
      lineNo += 1;
    }
  } finally {
    rl.close();
    input.destroy();
    await finished(input, { cleanup: true }).catch(() => undefined);
  }
  return { ok: true, value: matches };
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
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

function temporaryWritePath(target: string): string {
  return `${target}.lvis-tmp-${process.pid}-${randomUUID()}`;
}

async function atomicTextWrite(target: string, content: string): Promise<void> {
  const temp = temporaryWritePath(target);
  try {
    await writeFile(temp, content, "utf8");
    await renameWithTransientRetry(temp, target);
  } catch (err) {
    try {
      await unlink(temp);
    } catch {
      // Best effort cleanup: preserve the original write/rename failure.
    }
    throw err;
  }
}

async function renameWithTransientRetry(source: string, target: string): Promise<void> {
  const delaysMs = [10, 25, 50, 100, 200];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (err) {
      if (attempt >= delaysMs.length || !isTransientRenameError(err)) {
        throw err;
      }
      await sleep(delaysMs[attempt]);
    }
  }
}

function isTransientRenameError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toolError(output: string): ToolErrorResult {
  return { output, isError: true };
}
