/**
 * SkillStore — markdown-with-frontmatter skill loader for the `skill_load`
 * LLM tool. Skills live in `~/.lvis/skills/<name>.md` (user-authored) plus
 * a built-in directory shipped with the app at `dist/skills/` so the tool
 * is not dead on first install.
 *
 * Frontmatter contract:
 *   ---
 *   name: <skill name>           # required, unique
 *   description: <one line>      # surfaced as the badge subtitle
 *   triggers: ["..."]            # optional keyword hints (LLM consumes)
 *   ---
 *   <markdown body>              # appended to chat history as a system message
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { BUILTIN_SKILLS } from "./builtin-skills.js";

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
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const skills: LoadedSkill[] = [];
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".md")) continue;
      const filePath = join(dir, entry);
      try {
        const raw = await readFile(filePath, "utf-8");
        const { fm, body } = parseFrontmatter(raw);
        const name = fm.name || entry.replace(/\.md$/i, "");
        skills.push({
          name,
          description: fm.description ?? "",
          triggers: fm.triggers ?? [],
          body: body.trim(),
          source,
          filePath,
        });
      } catch (err) {
        console.warn(
          `[lvis] skill load failed for ${filePath}:`,
          (err as Error).message,
        );
      }
    }
    return skills;
  }
}
