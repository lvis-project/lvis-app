/**
 * Shared minimatch-subset matcher for permission path policy and native
 * file search. It intentionally supports only the glob features used by
 * LVIS policy/tool surfaces:
 *
 *   **  — zero or more path segments
 *   *   — zero or more characters within one segment
 *   ?   — one character within one segment
 */

export interface GlobMatcherOptions {
  caseInsensitive?: boolean;
}

export function globToRegExp(
  pattern: string,
  opts: GlobMatcherOptions = {},
): RegExp {
  const normalized = normalizeGlobPath(pattern);
  const flags = opts.caseInsensitive === true ? "i" : "";
  return new RegExp(`^${globToRegExpSource(normalized)}$`, flags);
}

export function globMatch(
  path: string,
  pattern: string,
  opts: GlobMatcherOptions = {},
): boolean {
  const caseInsensitive =
    opts.caseInsensitive ??
    (process.platform === "darwin" || process.platform === "win32");
  return globToRegExp(pattern, { caseInsensitive }).test(normalizeGlobPath(path));
}

function globToRegExpSource(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    const next = pattern[i + 1];
    if (ch === "*" && next === "*") {
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    out += escapeRegex(ch);
    i += 1;
  }
  return out;
}

function escapeRegex(ch: string): string {
  return /[\\^$+?.()|[\]{}]/.test(ch) ? `\\${ch}` : ch;
}

function normalizeGlobPath(value: string): string {
  return value.replace(/\\/g, "/");
}
