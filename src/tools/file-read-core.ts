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
import { createReadStream, realpathSync } from "node:fs";
import { isAbsolute, resolve as pathResolve } from "node:path";
import { finished } from "node:stream/promises";

import { expandLeadingTilde } from "../shared/home-tilde.js";
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
  const expanded = expandLeadingTilde(inputPath);
  const lexical = isAbsolute(expanded) ? pathResolve(expanded) : pathResolve(cwd, expanded);
  // Resolve symlinks up-front so the guard checks AND the eventual stat/read
  // operate on the SAME canonical target — closes the check-vs-read TOCTOU gap
  // where a symlink could point inside an allowed root at validation time and be
  // swapped out afterwards, and catches a symlink whose real target is a Layer 0
  // sensitive file. A not-yet-existing path throws → keep the lexical form so the
  // downstream stat still yields a clean not-a-file/read-failed.
  let resolved = lexical;
  try {
    resolved = realpathSync.native(lexical);
  } catch {
    resolved = lexical;
  }
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
  try {
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } finally {
    stream.destroy();
    await finished(stream, { cleanup: true }).catch(() => undefined);
  }
  return Buffer.concat(chunks).includes(0);
}

/**
 * Read a zero-based line window of a UTF-8 text file. `content` preserves the
 * source separators between selected lines, omitting the final line's separator.
 * `lines` contains the same logical lines without separators, and `truncated`
 * reports whether more lines existed past `limit`.
 */
export async function readTextFileWindow(
  path: string,
  offset: number,
  limit: number,
): Promise<{ lines: string[]; content: string; truncated: boolean }> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines: string[] = [];
  const contentParts: string[] = [];
  let lineParts: string[] = [];
  let lineNo = 0;
  let previousSeparator = "";
  let pendingCR = false;
  let lineOpen = false;
  let truncated = false;

  const append = (fragment: string): void => {
    if (fragment.length === 0) return;
    lineOpen = true;
    if (lineNo >= offset && lines.length < limit) lineParts.push(fragment);
  };

  const finishLine = (separator: string): boolean => {
    if (lineNo >= offset) {
      if (lines.length >= limit) {
        truncated = true;
        return false;
      }
      const line = lineParts.join("");
      if (lines.length > 0) contentParts.push(previousSeparator);
      lines.push(line);
      contentParts.push(line);
    }
    lineParts = [];
    lineOpen = false;
    lineNo += 1;
    previousSeparator = separator;
    return true;
  };

  try {
    read: for await (const chunk of input) {
      if (chunk.length === 0) continue;
      let start = 0;
      // A CR at a chunk boundary may be the first half of a CRLF separator.
      if (pendingCR) {
        pendingCR = false;
        const hasLF = chunk.startsWith("\n");
        if (!finishLine(hasLF ? "\r\n" : "\r")) break;
        if (hasLF) start = 1;
      }

      const separators = /\r\n|\r|\n/g;
      separators.lastIndex = start;
      let match: RegExpExecArray | null;
      while ((match = separators.exec(chunk)) !== null) {
        append(chunk.slice(start, match.index));
        start = separators.lastIndex;
        if (match[0] === "\r" && start === chunk.length) {
          pendingCR = true;
          break;
        }
        if (!finishLine(match[0])) break read;
      }
      append(chunk.slice(start));
    }
    if (!truncated) {
      if (pendingCR) finishLine("\r");
      else if (lineOpen) finishLine("");
    }
  } finally {
    input.destroy();
    await finished(input, { cleanup: true }).catch(() => undefined);
  }
  return { lines, content: contentParts.join(""), truncated };
}
