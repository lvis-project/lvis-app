/**
 * Shared file-read core (§6.10). The single source of truth for "which files
 * may be read for display, and how their text is windowed" — imported by BOTH
 * the builtin `read_file` tool (`file-tools.ts`) AND the preview-read IPC
 * handler (`ipc/domains/preview.ts`).
 *
 * INVARIANT (No-Fallback / SOT): the set of files a renderer may read for
 * preview MUST equal the set the agent's `read_file` reads without approval.
 * Both callers share {@link assertReadableFilePath} + {@link readTextFileWindow}
 * so the two never diverge — extracting them here makes that equality a
 * compile-time fact instead of a copy-paste that rots.
 */
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as pathResolve } from "node:path";
import { createInterface } from "node:readline";

import { validateSandboxPath } from "../sandbox/path-validator.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../permissions/sensitive-paths.js";

/** Hard cap for text files rendered/read for preview (matches read_file). */
export const MAX_TEXT_FILE_BYTES = 2_000_000;
/** Leading-byte sample size used for the NUL-byte binary sniff. */
export const BINARY_SAMPLE_BYTES = 8_192;

export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * A glob pattern (`**\/*.md`, `foo?.ts`, `a{b,c}`) is a tool ARGUMENT, never a
 * concrete file — refusing it early is defense-in-depth so a renderer that
 * mistakes a pattern for a path can't drive a `stat("**\/*.md")`.
 */
export function isGlobPattern(value: string): boolean {
  return /[*?[\]{}]/.test(value) || value.includes("**");
}

export type AssertReadableFailure = "not-a-file" | "sensitive-path" | "path-not-allowed";

export type AssertReadableResult =
  | { ok: true; resolved: string }
  | { ok: false; error: AssertReadableFailure };

/**
 * Resolve + guard a candidate file path with the EXACT sequence the builtin
 * file tools use (`FileTool.ensureAllowed`): glob reject → Layer 0 sensitive
 * hard-block → Layer 1 sandbox boundary (symlink-safe realpath).
 *
 * Ordering is load-bearing: `~/.lvis` is a Layer 1 allow root, but
 * `~/.lvis/secrets` / `~/.lvis/sessions` are Layer 0 denies — sensitive MUST be
 * checked before the boundary so allow-listed roots never leak their sensitive
 * children.
 */
export function assertReadableFilePath(
  inputPath: string,
  cwd: string,
  extraAllowed: readonly string[],
): AssertReadableResult {
  if (isGlobPattern(inputPath)) return { ok: false, error: "not-a-file" };
  const expanded = expandTilde(inputPath);
  const resolved = isAbsolute(expanded) ? pathResolve(expanded) : pathResolve(cwd, expanded);
  const sensitive = isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(resolved)));
  if (sensitive) return { ok: false, error: "sensitive-path" };
  const check = validateSandboxPath(resolved, cwd, [...extraAllowed]);
  if (!check.allowed) return { ok: false, error: "path-not-allowed" };
  return { ok: true, resolved };
}

/** NUL-byte sniff over the leading {@link BINARY_SAMPLE_BYTES}. */
export async function isBinaryFile(path: string): Promise<boolean> {
  const stream = createReadStream(path, { start: 0, end: BINARY_SAMPLE_BYTES - 1 });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).includes(0);
}

/**
 * Read a zero-based line window of a UTF-8 text file. Returns the collected
 * lines and whether more lines existed past `limit` (truncated).
 */
export async function readTextFileWindow(
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
