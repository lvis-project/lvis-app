/**
 * SkillStore — markdown-with-frontmatter skill loader for the `skill_load`
 * LLM tool. Skills live under `~/.lvis/skills/` as either
 * `skills/<name>/SKILL.md` (preferred agent-platform layout) or
 * `skills/<name>.md` flat files. Built-in skills ship as files under
 * `resources/skills/` and are seeded into `~/.lvis/skills/` on first boot
 * by `seed-lvis-home-docs.ts`, so the user can freely edit each prompt.
 *
 * Frontmatter contract:
 *   ---
 *   name: <skill name>           # required, unique
 *   description: <one line>      # surfaced as the badge subtitle
 *   ---
 *   <markdown body>              # loaded into the current-turn prompt overlay
 */
import { readFile, readdir, realpath } from "node:fs/promises";
import { closeSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
import type { ActivePluginGeneration } from "../plugins/plugin-generation-coordinator.js";
import type { MaterializedPluginContribution } from "../plugins/plugin-contributions.js";
const log = createLogger("lvis");

/**
 * C2(b): allowlist for skill names. Skill files live in
 * `~/.lvis/skills/<name>/SKILL.md`; any name with `/`, `..`, NUL, or other
 * non-printable noise is rejected up-front so an attacker cannot use the
 * `skillName` arg to navigate outside the directory or smuggle shell
 * metacharacters into the resolved file path.
 */
export const SKILL_NAME_ALLOWLIST = /^[a-zA-Z0-9_-]+$/;
const PLUGIN_SKILL_SELECTOR_ALLOWLIST = /^plugin:[a-z][a-z0-9-]{2,127}:[a-zA-Z_][a-zA-Z0-9_]*$/;
export const SKILL_SELECTOR_ALLOWLIST = /^(?:[a-zA-Z0-9_-]+|plugin:[a-z][a-z0-9-]{2,127}:[a-zA-Z_][a-zA-Z0-9_]*)$/;

/** C2(e): skills with a body larger than this are refused at load time. */
export const SKILL_MAX_BODY_BYTES = 8 * 1024;

export interface SkillFrontmatter {
  name: string;
  description?: string;
}

function materializedSkill(
  generation: ActivePluginGeneration,
  contribution: MaterializedPluginContribution,
): LoadedSkill {
  const entryPath = `${contribution.path}/SKILL.md`;
  const entry = contribution.files.find((file) => file.path === entryPath);
  if (!entry) throw new Error(`materialized Skill '${contribution.localId}' is missing SKILL.md`);
  const { fm, body } = parseFrontmatter(entry.content);
  const trimmedBody = body.trim();
  if (Buffer.byteLength(trimmedBody, "utf-8") > SKILL_MAX_BODY_BYTES) {
    throw new Error(`materialized Skill '${contribution.localId}' exceeds ${SKILL_MAX_BODY_BYTES} bytes`);
  }
  const owner: PluginSkillOwner = Object.freeze({
    pluginId: generation.pluginId,
    pluginVersion: generation.pluginVersion,
    generationId: generation.generationId,
    localId: contribution.localId,
    fingerprint: contribution.fingerprint,
  });
  const selector = `plugin:${owner.pluginId}:${owner.localId}`;
  return Object.freeze({
    name: selector,
    description: fm.description ?? "",
    body: trimmedBody,
    filePath: `plugin://${owner.pluginId}/${owner.localId}/SKILL.md`,
    approvalKey: [owner.pluginId, owner.pluginVersion, owner.generationId, owner.localId, owner.fingerprint].join("|"),
    pluginOwner: owner,
  });
}

export interface LoadedSkill {
  name: string;
  description: string;
  body: string;
  filePath: string;
  /** Exact cache/approval identity for plugin-owned materialized bytes. */
  approvalKey?: string;
  pluginOwner?: PluginSkillOwner;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  pluginOwner?: PluginSkillOwner;
}

interface PluginSkillOwner {
  pluginId: string;
  pluginVersion: string;
  generationId: string;
  localId: string;
  fingerprint: string;
}

export interface PreparedPluginSkillGeneration {
  readonly pluginId: string;
  readonly generationId: string;
  publish(): void;
}

interface SkillCatalogRecord extends SkillCatalogEntry {
  baseName: string;
  filePath: string;
}

const USER_SKILLS_DIR = resolve(lvisHome(), "skills");
const SKILL_CATALOG_SCAN_LIMIT = 256;
const SKILL_FRONTMATTER_READ_BYTES = 16 * 1024;
const SKILL_CATALOG_DESCRIPTION_MAX_CHARS = 1024;

/**
 * Parse a YAML-ish frontmatter block. Supports `key: value` lines.
 * Quoted strings (single/double) are unwrapped.
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
    val = val.replace(/^["']|["']$/g, "");
    if (key === "name") fm.name = val;
    else if (key === "description") fm.description = val;
  }
  return { fm, body };
}

export interface SkillStoreOptions {
  /** Override user-skills directory. */
  userDir?: string;
}

export class SkillStore {
  private readonly userDir: string;
  private pluginSkills = new Map<string, LoadedSkill>();

  constructor(opts: SkillStoreOptions = {}) {
    this.userDir = opts.userDir ?? USER_SKILLS_DIR;
  }

  /** List skills available under the user skills directory. */
  async list(): Promise<LoadedSkill[]> {
    const out = await this.scanDir(this.userDir);
    const byName = new Map<string, LoadedSkill>();
    for (const s of out) byName.set(s.name, s);
    return [...byName.values(), ...this.pluginSkills.values()];
  }

  /**
   * Synchronous lightweight catalog for prompt assembly. It returns only
   * metadata; skill bodies stay behind `skill_load` and the approval gate.
   */
  listCatalogSync(): SkillCatalogEntry[] {
    const out = this.scanCatalogDirSync(this.userDir);
    const byName = new Map<string, SkillCatalogEntry>();
    for (const s of out) {
      byName.set(s.name, {
        name: s.name,
        description: s.description,
      });
    }
    return [
      ...byName.values(),
      ...[...this.pluginSkills.values()].map((skill) => ({
        name: skill.name,
        description: skill.description,
        pluginOwner: skill.pluginOwner,
      })),
    ];
  }

  async load(name: string): Promise<LoadedSkill | null> {
    if (PLUGIN_SKILL_SELECTOR_ALLOWLIST.test(name)) {
      return this.pluginSkills.get(name) ?? null;
    }
    if (!SKILL_NAME_ALLOWLIST.test(name)) return null;
    let canonicalDir: string;
    try {
      canonicalDir = await realpath(this.userDir);
    } catch {
      canonicalDir = resolve(this.userDir);
    }
    const candidates = [
      join(this.userDir, name, "SKILL.md"),
      join(this.userDir, `${name}.md`),
    ];
    const loaded: LoadedSkill[] = [];
    for (const filePath of candidates) {
      let canonicalFile: string;
      try {
        canonicalFile = await realpath(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn(`skill load: realpath failed for ${filePath}: %s`, (err as Error).message);
        }
        continue;
      }
      const rel = relative(canonicalDir, canonicalFile);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        log.warn(`skill load: rejected traversal — ${filePath} -> ${canonicalFile} escapes ${canonicalDir}`);
        continue;
      }
      try {
        loaded.push(await this.loadFile(canonicalFile, name));
      } catch (err) {
        log.warn(`skill load failed for ${filePath}: %s`, (err as Error).message);
      }
    }
    if (loaded.length > 1) {
      log.warn(`skill load: duplicate skill id "${name}" exists as both directory and flat file; refusing ambiguous load`);
      return null;
    }
    return loaded[0] ?? null;
  }

  /** Resolve a plugin Skill only from an already-admitted immutable generation. */
  loadPluginGeneration(generation: ActivePluginGeneration, selector: string): LoadedSkill | null {
    const prefix = `plugin:${generation.pluginId}:`;
    if (!selector.startsWith(prefix)) return null;
    const localId = selector.slice(prefix.length);
    const contribution = generation.contributions.find(
      (entry) => entry.kind === "skill" && entry.localId === localId,
    );
    return contribution ? materializedSkill(generation, contribution) : null;
  }

  /** Publish materialized Skill bytes for exactly one active plugin generation. */
  publishPluginGeneration(generation: ActivePluginGeneration): void {
    this.preparePluginGeneration(generation).publish();
  }

  /** Parse and prebuild the complete Skill snapshot before durable commit. */
  preparePluginGeneration(generation: ActivePluginGeneration): PreparedPluginSkillGeneration {
    const next = new Map(this.pluginSkills);
    for (const [selector, skill] of next) {
      if (skill.pluginOwner?.pluginId === generation.pluginId) next.delete(selector);
    }
    for (const contribution of generation.contributions) {
      if (contribution.kind !== "skill") continue;
      const skill = materializedSkill(generation, contribution);
      if (next.has(skill.name)) {
        throw new Error(`duplicate plugin Skill selector: ${skill.name}`);
      }
      next.set(skill.name, skill);
    }
    let published = false;
    return Object.freeze({
      pluginId: generation.pluginId,
      generationId: generation.generationId,
      publish: () => {
        if (published) return;
        this.pluginSkills = next;
        published = true;
      },
    });
  }

  /** Prebuild exact plugin catalog removal; leased overlays keep their body. */
  preparePluginRemoval(pluginId: string, generationId: string): PreparedPluginSkillGeneration {
    const next = new Map(this.pluginSkills);
    for (const [selector, skill] of next) {
      if (skill.pluginOwner?.pluginId === pluginId && skill.pluginOwner.generationId === generationId) {
        next.delete(selector);
      }
    }
    let published = false;
    return Object.freeze({
      pluginId,
      generationId,
      publish: () => {
        if (published) return;
        this.pluginSkills = next;
        published = true;
      },
    });
  }

  /** Remove one retired generation without touching user/global skill files. */
  removePluginGeneration(pluginId: string, generationId: string): void {
    for (const [selector, skill] of this.pluginSkills) {
      if (skill.pluginOwner?.pluginId === pluginId && skill.pluginOwner.generationId === generationId) {
        this.pluginSkills.delete(selector);
      }
    }
  }

  removePlugin(pluginId: string): void {
    for (const [selector, skill] of this.pluginSkills) {
      if (skill.pluginOwner?.pluginId === pluginId) this.pluginSkills.delete(selector);
    }
  }

  private async scanDir(dir: string): Promise<LoadedSkill[]> {
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
    let canonicalDir: string;
    try {
      canonicalDir = await realpath(dir);
    } catch {
      canonicalDir = resolve(dir);
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
      let canonicalFile: string;
      try {
        canonicalFile = await realpath(filePath);
      } catch (err) {
        log.warn(
          `skill scan: realpath failed for ${filePath}: %s`,
          (err as Error).message,
        );
        continue;
      }
      const rel = relative(canonicalDir, canonicalFile);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        log.warn(
          `skill scan: rejected traversal — ${filePath} -> ${canonicalFile} escapes ${canonicalDir}`,
        );
        continue;
      }
      try {
        skills.push(await this.loadFile(canonicalFile, baseName));
      } catch (err) {
        log.warn(
          `skill load failed for ${filePath}: %s`,
          (err as Error).message,
        );
      }
    }
    return skills;
  }

  private async loadFile(canonicalFile: string, baseName: string): Promise<LoadedSkill> {
    const raw = await readFile(canonicalFile, "utf-8");
    const { fm, body } = parseFrontmatter(raw);
    const name = resolveSkillName(baseName, fm);
    const trimmedBody = body.trim();
    // C2(e): cap body length so a malicious skill cannot blow up the
    // system prompt or chew up tokens. 8 KB is generous for a markdown
    // skill and tight enough that abuse is bounded.
    if (Buffer.byteLength(trimmedBody, "utf-8") > SKILL_MAX_BODY_BYTES) {
      throw new Error(`rejected oversized body (>${SKILL_MAX_BODY_BYTES} bytes)`);
    }
    return {
      name,
      description: fm.description ?? "",
      body: trimmedBody,
      filePath: canonicalFile,
    };
  }

  private scanCatalogDirSync(dir: string, limit = SKILL_CATALOG_SCAN_LIMIT): SkillCatalogRecord[] {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    let canonicalDir: string;
    try {
      canonicalDir = realpathSync(dir);
    } catch {
      canonicalDir = resolve(dir);
    }

    const skills: SkillCatalogRecord[] = [];
    const sortedEntries = entries
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    const limitedEntries = Number.isFinite(limit)
      ? sortedEntries.slice(0, limit)
      : sortedEntries;
    if (Number.isFinite(limit) && entries.length > limit) {
      log.warn(
        `skill catalog: scanned first ${limit} entries out of ${entries.length}`,
      );
    }

    for (const entry of limitedEntries) {
      const candidate = this.skillCandidate(dir, entry);
      if (!candidate) continue;
      const { baseName, filePath } = candidate;
      if (!SKILL_NAME_ALLOWLIST.test(baseName)) {
        log.warn(`skill catalog: rejected non-allowlist entry: ${entry.name}`);
        continue;
      }

      let canonicalFile: string;
      try {
        canonicalFile = realpathSync(filePath);
      } catch (err) {
        log.warn(
          `skill catalog: realpath failed for ${filePath}: %s`,
          (err as Error).message,
        );
        continue;
      }
      const rel = relative(canonicalDir, canonicalFile);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        log.warn(
          `skill catalog: rejected traversal — ${filePath} -> ${canonicalFile} escapes ${canonicalDir}`,
        );
        continue;
      }

      try {
        const fm = readFrontmatterSync(canonicalFile);
        const name = resolveSkillName(baseName, fm);
        skills.push({
          name,
          description: normalizeCatalogDescription(fm.description ?? ""),
          baseName,
          filePath: canonicalFile,
        });
      } catch (err) {
        log.warn(
          `skill catalog failed for ${filePath}: %s`,
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

function readFrontmatterSync(filePath: string): SkillFrontmatter {
  const buf = Buffer.alloc(SKILL_FRONTMATTER_READ_BYTES);
  const fd = openSync(filePath, "r");
  try {
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const raw = buf.toString("utf-8", 0, bytes);
    const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    if (!match) return { name: "" };
    return parseFrontmatter(`---\n${match[1]}\n---\n`).fm;
  } finally {
    closeSync(fd);
  }
}

function resolveSkillName(baseName: string, fm: SkillFrontmatter): string {
  const name = fm.name || baseName;
  // C2(b): frontmatter may not redefine the canonical skill id. This keeps
  // catalog metadata and `skill_load({skillName})` pointed at the same file
  // and avoids duplicate-alias ambiguity.
  if (name !== baseName) {
    throw new Error(`frontmatter name "${name}" must match skill id "${baseName}"`);
  }
  if (!SKILL_NAME_ALLOWLIST.test(name)) {
    throw new Error(`rejected non-allowlist frontmatter name "${name}"`);
  }
  return name;
}

function normalizeCatalogDescription(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, " ").replace(/[<>]/g, "").trim();
  if (oneLine.length <= SKILL_CATALOG_DESCRIPTION_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, SKILL_CATALOG_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`;
}
