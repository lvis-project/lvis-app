/**
 * SkillStore — markdown-with-frontmatter skill loader for the `skill_load`
 * LLM tool. User-authored skills live under `~/.lvis/skills/` as either
 * `skills/<name>/SKILL.md` (preferred agent-platform layout) or legacy
 * `skills/<name>.md` files. Built-ins ship inline and optional packaged
 * skills can be loaded from `dist/skills/`.
 *
 * Frontmatter contract:
 *   ---
 *   name: <skill name>           # required, unique
 *   description: <one line>      # surfaced as the badge subtitle
 *   triggers: ["..."]            # optional keyword hints (LLM consumes)
 *   ---
 *   <markdown body>              # appended to chat history as a system message
 */
import { readFile, readdir, realpath } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { BUILTIN_SKILLS } from "./builtin-skills.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

/**
 * C2(b): allowlist for skill names. Skill files live in
 * `~/.lvis/skills/<name>/SKILL.md`; any name with `/`, `..`, NUL, or other
 * non-printable noise is rejected up-front so an attacker cannot use the
 * `skillName` arg to navigate outside the directory or smuggle shell
 * metacharacters into the resolved file path.
 */
export const SKILL_NAME_ALLOWLIST = /^[a-zA-Z0-9_-]+$/;

/** C2(e): skills with a body larger than this are refused at load time. */
export const SKILL_MAX_BODY_BYTES = 8 * 1024;

export interface SkillFrontmatter {
  name: string;
  description?: string;
  triggers?: string[];
}

export interface LoadedSkill {
  name: string;
  description: string;
  triggers: string[];
  body: string;
  source: "user" | "builtin";
  filePath: string;
}

const USER_SKILLS_DIR = resolve(homedir(), ".lvis", "skills");

/**
 * Parse a YAML-ish frontmatter block. Supports `key: value` lines and
 * `key: [a, b, c]` arrays. Quoted strings (single/double) are unwrapped.
 * Deliberately tiny — full YAML would pull in a dep we don't need.
 */
export function parseFrontmatter(raw: string): {
  fm: SkillFrontmatter;
  body: string;
} {
  const fmRegex = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;
  const match = raw.match(fmRegex);
  if (!match) {
    return { fm: { name: "" }, body: raw };
  }
  const [full, block] = match;
  const body = raw.slice(full.length);
  const fm: SkillFrontmatter = { name: "" };
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      const arr = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0);
      if (key === "triggers") fm.triggers = arr;
      continue;
    }
    val = val.replace(/^["']|["']$/g, "");
    if (key === "name") fm.name = val;
    else if (key === "description") fm.description = val;
  }
  return { fm, body };
}

export interface SkillStoreOptions {
  /** Override user-skills directory. */
  userDir?: string;
  /** Built-in skills directory (`dist/skills/` in production). */
  builtinDir?: string;
}

export class SkillStore {
  private readonly userDir: string;
  private readonly builtinDir: string | null;

  constructor(opts: SkillStoreOptions = {}) {
    this.userDir = opts.userDir ?? USER_SKILLS_DIR;
    this.builtinDir = opts.builtinDir ?? null;
  }

  /** List skills available across builtin + user directories. */
  async list(): Promise<LoadedSkill[]> {
    const out: LoadedSkill[] = [];
    // Built-ins shipped inline first; user-authored next so they win on collision.
    out.push(...BUILTIN_SKILLS);
    if (this.builtinDir) {
      out.push(...(await this.scanDir(this.builtinDir, "builtin")));
    }
    out.push(...(await this.scanDir(this.userDir, "user")));
    const byName = new Map<string, LoadedSkill>();
    for (const s of out) byName.set(s.name, s);
    return [...byName.values()];
  }

  async load(name: string): Promise<LoadedSkill | null> {
    const all = await this.list();
    return all.find((s) => s.name === name) ?? null;
  }

  private async scanDir(
    dir: string,
    source: "user" | "builtin",
  ): Promise<LoadedSkill[]> {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    // C2(a): resolve the directory's real path ONCE so each scanned entry
    // can be confined against it. If the directory itself doesn't exist as
    // a real path (just-created via mkdir, race conditions), fall back to
    // the supplied `dir` value — confinement still works because we resolve
    // every entry the same way.
    let realDir: string;
    try {
      realDir = await realpath(dir);
    } catch {
      realDir = resolve(dir);
    }

    const skills: LoadedSkill[] = [];
    for (const entry of entries) {
      const candidate = this.skillCandidate(dir, entry);
      if (!candidate) continue;
      const { baseName, filePath } = candidate;
      // C2(b): allowlist on filename — reject anything with `/`, `..`, NUL,
      // or other disallowed characters before opening the file.
      if (!SKILL_NAME_ALLOWLIST.test(baseName)) {
        log.warn(`skill scan: rejected non-allowlist entry: ${entry.name}`);
        continue;
      }
      // C2(a): resolve the entry's real path and verify it stays inside
      // the (real) skills directory. Symlinks pointing outside (e.g.
      // `evil.md → /etc/passwd`) are rejected here.
      let realFile: string;
      try {
        realFile = await realpath(filePath);
      } catch (err) {
        log.warn(
          `skill scan: realpath failed for ${filePath}: %s`,
          (err as Error).message,
        );
        continue;
      }
      const rel = relative(realDir, realFile);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        log.warn(
          `skill scan: rejected traversal — ${filePath} -> ${realFile} escapes ${realDir}`,
        );
        continue;
      }
      try {
        const raw = await readFile(realFile, "utf-8");
        const { fm, body } = parseFrontmatter(raw);
        const name = fm.name || baseName;
        // C2(b): the resolved-from-frontmatter name is also subject to the
        // allowlist; if a malicious frontmatter sets `name: ../../etc`, we
        // reject the skill rather than carry that ID into the load() lookup.
        if (!SKILL_NAME_ALLOWLIST.test(name)) {
          log.warn(
            `skill scan: rejected non-allowlist frontmatter name "${name}" in ${realFile}`,
          );
          continue;
        }
        const trimmedBody = body.trim();
        // C2(e): cap body length so a malicious skill cannot blow up the
        // system prompt or chew up tokens. 8 KB is generous for a markdown
        // skill and tight enough that abuse is bounded.
        if (Buffer.byteLength(trimmedBody, "utf-8") > SKILL_MAX_BODY_BYTES) {
          log.warn(
            `skill scan: rejected oversized body for ${realFile} (>${SKILL_MAX_BODY_BYTES} bytes)`,
          );
          continue;
        }
        skills.push({
          name,
          description: fm.description ?? "",
          triggers: fm.triggers ?? [],
          body: trimmedBody,
          source,
          filePath: realFile,
        });
      } catch (err) {
        log.warn(
          `skill load failed for ${filePath}: %s`,
          (err as Error).message,
        );
      }
    }
    return skills;
  }

  private skillCandidate(
    dir: string,
    entry: import("node:fs").Dirent,
  ): { baseName: string; filePath: string } | null {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      return {
        baseName: entry.name.replace(/\.md$/i, ""),
        filePath: join(dir, entry.name),
      };
    }
    if (entry.isDirectory()) {
      return {
        baseName: entry.name,
        filePath: join(dir, entry.name, "SKILL.md"),
      };
    }
    return null;
  }
}
