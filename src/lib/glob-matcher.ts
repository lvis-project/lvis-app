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

/**
 * Whether `value` would be read as a pattern rather than as itself.
 *
 * Callers that derive a pattern from a real name — a filesystem path the user
 * read on an approval card, say — need this before storing that string
 * somewhere it will later be glob-matched. A directory literally named
 * `Reports*2024` is a legal name on macOS and Linux, and storing it as a
 * pattern silently widens whatever it authorises to every sibling matching
 * `Reports<anything>2024`.
 *
 * Rejection is the only available defence, because this grammar cannot express
 * a literal metacharacter: `globToRegExpSource` has no backslash-escape branch,
 * and `normalizeGlobPath` rewrites `\` to `/` before it ever runs. Everything
 * else — brackets and braces included — already reaches `escapeRegex` and is
 * matched literally, so `*` and `?` are the whole set. `__tests__` pins that
 * claim against the matcher itself rather than restating it.
 */
export function containsGlobMetacharacter(value: string): boolean {
  return value.includes("*") || value.includes("?");
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
