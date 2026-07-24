/**
 * Project AGENTS.md discovery — leaf module.
 *
 * Discovers the active project's committed `AGENTS.md` (the team-shared,
 * version-controlled instruction file that Codex / Claude Code / the AGENTS.md
 * standard all treat as the primary distribution channel) so it can be injected
 * as a distinct layer BELOW the global personal `~/.lvis/AGENTS.md`.
 *
 * The first step discovers exactly `<projectRoot>/AGENTS.md`. LVIS has no per-turn
 * working-subdir signal distinct from `projectRoot`, so a genuine root-to-leaf
 * closest-wins chain (and multi-root fan-out over additionalDirectories) would
 * be dead code today; the shape below keeps that extension cheap without
 * shipping an unreachable branch. See `docs/development/` loading policy for the
 * "no dead fallback" constraint.
 *
 * Pure + dependency-free (node:fs/node:path only) so it stays a memory-layer
 * leaf with no upward dependency on engine/ or prompts/.
 */
import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

interface ProjectAgentsMdLayer {
  /** Path relative to the project root (always `AGENTS.md` for now). */
  relativePath: string;
  /** LF-normalized content, head-truncated to the remaining byte budget. */
  content: string;
  /** True when the file exceeded the byte budget and was head-clamped. */
  truncated: boolean;
}

export interface ProjectAgentsMd {
  /** Canonicalized project root the discovery was scoped to. */
  projectRoot: string;
  /** Ordered root-first (closest-last); yields at most one for now. */
  layers: ProjectAgentsMdLayer[];
  /** Total UTF-8 bytes of injected content, always <= maxTotalBytes. */
  totalBytes: number;
}

/** Codex parity: a committed AGENTS.md is capped so it cannot flood the prompt. */
export const PROJECT_AGENTS_MD_MAX_TOTAL_BYTES = 32 * 1024;

/**
 * A candidate is read only if its *realpath* is at or below the project root's
 * realpath — a symlinked `AGENTS.md` pointing outside the authorized root is
 * skipped (it must not be able to smuggle arbitrary host files into the prompt).
 * A missing candidate/root canonicalizes to a throw and is treated as "not
 * readable" (absent), which is the correct outcome for discovery.
 */
function isRealpathWithinRoot(root: string, candidate: string): boolean {
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalCandidate = realpathSync(candidate);
    return canonicalCandidate === canonicalRoot || canonicalCandidate.startsWith(`${canonicalRoot}${sep}`);
  } catch {
    return false;
  }
}

/** Slice to at most `maxBytes` without splitting a multi-byte UTF-8 sequence. */
function utf8HeadSlice(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off while `end` lands on a continuation byte (10xxxxxx): slicing there
  // would split a character. Stop on an ASCII/lead byte so [0, end) is clean.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf-8");
}

/**
 * Discover the committed project AGENTS.md at `projectRoot`. Returns empty
 * `layers` when absent, empty-after-trim, a directory (EISDIR), or a symlink
 * escaping the root. Never throws for the expected filesystem cases.
 */
export function discoverProjectAgentsMd(
  projectRoot: string,
  opts: { maxTotalBytes?: number } = {},
): ProjectAgentsMd {
  const maxTotalBytes = opts.maxTotalBytes ?? PROJECT_AGENTS_MD_MAX_TOTAL_BYTES;
  const root = resolve(projectRoot);
  const empty: ProjectAgentsMd = { projectRoot: root, layers: [], totalBytes: 0 };

  const candidate = join(root, "AGENTS.md");
  if (!isRealpathWithinRoot(root, candidate)) return empty;

  let fd: number | null = null;
  try {
    fd = openSync(candidate, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return empty; // EISDIR / socket / fifo — not an instruction file
    const raw = readFileSync(fd, "utf-8").replace(/\r\n/g, "\n");
    if (raw.trim().length === 0) return empty; // whitespace-only
    const truncated = Buffer.byteLength(raw, "utf-8") > maxTotalBytes;
    const content = truncated ? utf8HeadSlice(raw, maxTotalBytes) : raw;
    return {
      projectRoot: root,
      layers: [{ relativePath: "AGENTS.md", content, truncated }],
      totalBytes: Buffer.byteLength(content, "utf-8"),
    };
  } catch {
    // ENOENT / ENOTDIR / EISDIR-on-open / permission — treat as absent.
    return empty;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}
