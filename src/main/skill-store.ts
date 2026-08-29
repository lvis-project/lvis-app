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
import { readFile, readdir, realpath, stat, open } from "node:fs/promises";
import { closeSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { resolve, join, relative, isAbsolute, dirname, basename, sep } from "node:path";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
import { PLUGIN_SKILL_SELECTOR_PATTERN } from "../shared/plugin-skill-selector.js";
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
// Built from the ONE selector pattern (src/shared/plugin-skill-selector.ts), so
// the catalog, `skill_load`/`skill_read`, and the turn-scope gate cannot drift.
const PLUGIN_SKILL_SELECTOR_ALLOWLIST = new RegExp(`^${PLUGIN_SKILL_SELECTOR_PATTERN}$`);
export const SKILL_SELECTOR_ALLOWLIST = new RegExp(
  `^(?:[a-zA-Z0-9_-]+|${PLUGIN_SKILL_SELECTOR_PATTERN})$`,
);

/** C2(e): skills with a body larger than this are refused at load time. */
export const SKILL_MAX_BODY_BYTES = 8 * 1024;

/**
 * Bundled-resource (stage-3) bounds. A skill may ship `references/`, `assets/`
 * … next to its SKILL.md; those files are surfaced as a manifest and read only
 * on demand through `skill_read`. Every bound below is a hard cap so untrusted
 * bundled content cannot flood the prompt, the context, or the scan.
 */
const SKILL_RESOURCE_MAX_BYTES = 256 * 1024;
const SKILL_RESOURCE_COUNT_CAP = 64;
const SKILL_RESOURCE_DEPTH_CAP = 4;
const SKILL_RESOURCE_SCAN_LIMIT = 256;
const SKILL_RESOURCE_PATH_MAX_CHARS = 256;

/**
 * A bundled resource path is host-facing *and* model-facing (it is rendered in
 * the trusted `<lvis-skill>` overlay), so it must be inert on both sides:
 * relative, no traversal, no absolute/drive/UNC form, no backslash, no `:`
 * (NTFS alternate data streams), and no control characters — a newline in a
 * filename would otherwise inject extra lines into trusted guidance.
 */
function isSafeResourcePath(resourcePath: string): boolean {
  if (typeof resourcePath !== "string") return false;
  if (resourcePath.length === 0 || resourcePath.length > SKILL_RESOURCE_PATH_MAX_CHARS) return false;
  for (const char of resourcePath) {
    const code = char.codePointAt(0) ?? 0;
    // Control characters (a newline in a filename would inject extra lines
    // into the trusted overlay), plus fence/path metacharacters.
    if (code <= 0x1f || code === 0x7f) return false;
    if (char === "<" || char === ">" || char === "\\" || char === ":") return false;
  }
  if (isAbsolute(resourcePath) || resourcePath.startsWith("/")) return false;
  const segments = resourcePath.split("/");
  if (segments.length > SKILL_RESOURCE_DEPTH_CAP) return false;
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function assertSafeResourcePath(resourcePath: string): void {
  if (!isSafeResourcePath(resourcePath)) {
    throw new Error("rejected unsafe skill resource path");
  }
}

/**
 * Does a `relative()` result leave its root? Checked precisely: a plain
 * `startsWith("..")` would also reject a legitimate `..notes.md` filename.
 */
function escapesRoot(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * `skill_read` is a TEXT surface: content is decoded as UTF-8 and handed to the
 * model. Refuse NUL-bearing content — the reliable marker of a binary file —
 * rather than return corrupted bytes that read like content. (Invalid UTF-8
 * WITHOUT a NUL still decodes lossily; it is inert data on this channel.)
 */
function assertTextResource(content: string, resourcePath: string): void {
  if (content.includes("\u0000")) {
    throw new Error(`resource is not UTF-8 text: ${resourcePath}`);
  }
}

/** One bundled file next to a skill's SKILL.md. Metadata only — never content. */
export interface SkillResourceRef {
  /** Skill-root-relative POSIX path (never `SKILL.md`). */
  path: string;
  bytes: number;
}

/** Content of one bundled resource, returned by `skill_read`. */
export interface SkillResourceContent {
  path: string;
  content: string;
  bytes: number;
}

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
  // Stage-3 manifest, derived with ZERO filesystem access: the generation's
  // files are already materialized + sha256-verified in memory, so the manifest
  // is metadata over trusted bytes. `SKILL.md` itself is never a resource.
  const prefix = `${contribution.path}/`;
  const resources: SkillResourceRef[] = [];
  for (const file of contribution.files) {
    if (resources.length >= SKILL_RESOURCE_COUNT_CAP) break;
    if (file.path === entryPath || !file.path.startsWith(prefix)) continue;
    const relPath = file.path.slice(prefix.length);
    if (!isSafeResourcePath(relPath)) continue;
    const bytes = Buffer.byteLength(file.content, "utf-8");
    if (bytes > SKILL_RESOURCE_MAX_BYTES) continue;
    resources.push(Object.freeze({ path: relPath, bytes }));
  }
  return Object.freeze({
    name: selector,
    description: fm.description ?? "",
    body: trimmedBody,
    filePath: `plugin://${owner.pluginId}/${owner.localId}/SKILL.md`,
    approvalKey: [owner.pluginId, owner.pluginVersion, owner.generationId, owner.localId, owner.fingerprint].join("|"),
    pluginOwner: owner,
    resources: Object.freeze(resources),
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
  /**
   * Bundled files shipped next to SKILL.md (stage-3). Metadata only — contents
   * load on demand through `skill_read`. Always present; empty for flat skills.
   */
  resources: readonly SkillResourceRef[];
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

export interface FrontmatterBlock {
  /** `key` → the raw text after the colon (untrimmed, quotes intact). Last key wins. */
  fields: ReadonlyMap<string, string>;
  /** Everything after the closing `---`; the whole input when there is no block. */
  body: string;
}

/**
 * Split a markdown document into its YAML-ish `---` frontmatter block and
 * body. Supports `key: value` lines only — deliberately tiny, full YAML would
 * pull in a dep we don't need. Skills, agent profiles and persona prompts
 * all read their headers through this one parser; each maps the fields onto
 * its own typed shape.
 */
export function parseFrontmatterBlock(raw: string): FrontmatterBlock {
  const fmRegex = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;
  const match = raw.match(fmRegex);
  const fields = new Map<string, string>();
  if (!match) {
    return { fields, body: raw };
  }
  const [full, block] = match;
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    fields.set(m[1], m[2]);
  }
  return { fields, body: raw.slice(full.length) };
}

/** Trim a frontmatter scalar and unwrap one pair of surrounding quotes (single or double). */
export function unquoteFrontmatterValue(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

/** The skill header: `name` (required) and `description`. */
export function parseFrontmatter(raw: string): {
  fm: SkillFrontmatter;
  body: string;
} {
  const { fields, body } = parseFrontmatterBlock(raw);
  const fm: SkillFrontmatter = { name: unquoteFrontmatterValue(fields.get("name") ?? "") };
  const description = fields.get("description");
  if (description !== undefined) fm.description = unquoteFrontmatterValue(description);
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

  /**
   * Read one bundled resource of a PLUGIN skill — zero filesystem access.
   *
   * The generation's files were materialized and sha256-verified at install and
   * are held frozen in memory, so an exact `path` match against that set is the
   * whole integrity story: there is no disk re-read and therefore no TOCTOU.
   * Returns null when the selector, contribution, or resource does not exist.
   */
  readPluginResource(
    generation: ActivePluginGeneration,
    selector: string,
    resourcePath: string,
  ): SkillResourceContent | null {
    const prefix = `plugin:${generation.pluginId}:`;
    if (!selector.startsWith(prefix)) return null;
    const localId = selector.slice(prefix.length);
    const contribution = generation.contributions.find(
      (entry) => entry.kind === "skill" && entry.localId === localId,
    );
    if (!contribution) return null;
    assertSafeResourcePath(resourcePath);
    const entryPath = `${contribution.path}/SKILL.md`;
    const full = `${contribution.path}/${resourcePath}`;
    if (full === entryPath) return null; // SKILL.md is the body, not a resource
    const file = contribution.files.find((candidate) => candidate.path === full);
    if (!file) return null;
    const bytes = Buffer.byteLength(file.content, "utf-8");
    if (bytes > SKILL_RESOURCE_MAX_BYTES) {
      throw new Error(`skill resource exceeds ${SKILL_RESOURCE_MAX_BYTES} bytes`);
    }
    assertTextResource(file.content, resourcePath);
    return { path: resourcePath, content: file.content, bytes };
  }

  /**
   * Read one bundled resource of a USER skill, contained inside that skill's
   * own directory.
   *
   * A flat `<name>.md` skill is REFUSED before any filesystem access: its
   * `dirname` is the shared skills root, so treating it as a bundle root would
   * let one approved skill read every sibling skill's bytes — approval is
   * per-skill and body-hash-bound, and that must not become transitive.
   */
  async readUserResource(
    skill: Pick<LoadedSkill, "filePath"> & { pluginOwner?: LoadedSkill["pluginOwner"] },
    resourcePath: string,
  ): Promise<SkillResourceContent> {
    if (skill.pluginOwner) throw new Error("plugin skill resources load through readPluginResource");
    assertSafeResourcePath(resourcePath);
    const skillDir = dirname(skill.filePath);
    // Every filesystem resolution below runs inside a try: a raw ENOENT would
    // otherwise carry the absolute host path into the error text, which
    // `skill_read` returns verbatim to the model.
    let canonicalDir: string;
    try {
      canonicalDir = await realpath(skillDir);
    } catch (err) {
      // Log the true cause locally (EACCES vs ENOENT vs ELOOP); the model only
      // ever sees the sanitized text.
      log.warn(`skill resources: skill directory unresolvable: %s`, (err as Error).message);
      throw new Error(`skill directory unavailable for resource: ${resourcePath}`);
    }
    if (!(await this.isBundleRoot(canonicalDir, basename(skill.filePath)))) {
      throw new Error("flat skills have no bundled resources");
    }
    let canonicalFile: string;
    try {
      canonicalFile = await realpath(join(skillDir, resourcePath));
    } catch (err) {
      log.warn("skill resources: resolve failed: %s", (err as Error).message);
      throw new Error(`resource not found: ${resourcePath}`);
    }
    const rel = relative(canonicalDir, canonicalFile);
    if (escapesRoot(rel)) {
      throw new Error("skill resource escapes its skill directory");
    }
    if (rel.split(sep).join("/") === "SKILL.md") {
      throw new Error("SKILL.md is the skill body, not a resource");
    }
    // Bind the size check and the read to ONE file handle: re-opening by path
    // after `stat` leaves a swap window (mirrors the fd-bound read in
    // `tools/file-tools.ts`).
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(canonicalFile, "r");
    } catch (err) {
      log.warn("skill resources: open failed: %s", (err as Error).message);
      throw new Error(`resource not found: ${resourcePath}`);
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("skill resource is not a regular file");
      // A hardlink can name an out-of-tree inode from inside the directory, so
      // containment alone would not hold — the plugin ingest path rejects
      // `nlink > 1` for the same reason.
      if (info.nlink > 1) throw new Error("skill resource is a hardlink");
      if (info.size > SKILL_RESOURCE_MAX_BYTES) {
        throw new Error(`skill resource exceeds ${SKILL_RESOURCE_MAX_BYTES} bytes`);
      }
      const content = await handle.readFile("utf-8");
      assertTextResource(content, resourcePath);
      return { path: resourcePath, content, bytes: info.size };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /**
   * A bundle root must be the skill's OWN directory: a DIRECT CHILD of the
   * skills root, entered through `<name>/SKILL.md`.
   *
   * Anchoring on the skills root rather than on the filename is what makes this
   * safe. A flat file named `SKILL.md` sitting at the skills root — or a
   * `<name>/SKILL.md` symlinked to the root — has a `SKILL.md` basename yet its
   * directory IS the shared root, which would turn one approved skill into a
   * reader of every sibling skill's bytes. Approval is per-skill and
   * body-hash-bound; it must never become transitive.
   */
  private async isBundleRoot(canonicalDir: string, entryFileName: string): Promise<boolean> {
    if (entryFileName !== "SKILL.md") return false;
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(this.userDir);
    } catch {
      canonicalRoot = resolve(this.userDir);
    }
    const rootRel = relative(canonicalRoot, canonicalDir);
    if (rootRel === "" || escapesRoot(rootRel)) return false;
    return rootRel.split(sep).length === 1;
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
    // Stage-3: only the directory layout (`<name>/SKILL.md`) owns a bundle
    // directory. A flat `<name>.md` skill has no directory of its own — its
    // parent IS the shared skills root — so it never carries resources.
    const skillDir = dirname(canonicalFile);
    const resources = (await this.isBundleRoot(skillDir, basename(canonicalFile)))
      ? await this.listSkillResources(skillDir)
      : [];
    return {
      name,
      description: fm.description ?? "",
      body: trimmedBody,
      filePath: canonicalFile,
      resources,
    };
  }

  /**
   * List a directory-form skill's bundled files, root-relative and POSIX-normalized.
   *
   * Every entry is realpath-contained inside the skill directory (a symlink
   * pointing outside is skipped, mirroring `load()`), character-validated (a
   * filename with a newline or fence metacharacter is skipped so it can never
   * reach the trusted overlay), size-capped, and bounded by depth / count /
   * scan limits. Failures degrade to "no resources", never to a throw: a
   * broken bundle must not make the skill itself unloadable.
   */
  private async listSkillResources(skillDir: string): Promise<SkillResourceRef[]> {
    let canonicalDir: string;
    try {
      canonicalDir = await realpath(skillDir);
    } catch {
      return [];
    }
    const found: SkillResourceRef[] = [];
    const queue: Array<{ dir: string; depth: number }> = [{ dir: canonicalDir, depth: 0 }];
    // Canonical paths already visited. A symlink cycle (`loop -> .`) otherwise
    // re-emits the same file until the caps fill up, crowding real resources
    // out of both the manifest and the trusted overlay.
    const seen = new Set<string>([canonicalDir]);
    let scanned = 0;
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      if (found.length >= SKILL_RESOURCE_COUNT_CAP || scanned >= SKILL_RESOURCE_SCAN_LIMIT) break;
      let entries: Array<import("node:fs").Dirent>;
      try {
        entries = await readdir(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (found.length >= SKILL_RESOURCE_COUNT_CAP || scanned >= SKILL_RESOURCE_SCAN_LIMIT) break;
        scanned += 1;
        const childPath = join(current.dir, entry.name);
        let canonicalChild: string;
        let info: Awaited<ReturnType<typeof stat>>;
        try {
          // realpath + stat resolve symlinks; the containment check below then
          // rejects anything whose real location escapes the skill directory.
          canonicalChild = await realpath(childPath);
          info = await stat(canonicalChild);
        } catch {
          continue;
        }
        const rel = relative(canonicalDir, canonicalChild);
        if (escapesRoot(rel)) {
          log.warn(`skill resources: skipped ${childPath} — escapes ${canonicalDir}`);
          continue;
        }
        if (seen.has(canonicalChild)) continue;
        seen.add(canonicalChild);
        if (info.isDirectory()) {
          if (current.depth + 1 < SKILL_RESOURCE_DEPTH_CAP) {
            queue.push({ dir: canonicalChild, depth: current.depth + 1 });
          }
          continue;
        }
        if (!info.isFile()) continue;
        // A hardlink can name an out-of-tree inode from inside the directory,
        // so containment alone would not hold (the plugin ingest path rejects
        // `nlink > 1` for the same reason).
        if (info.nlink > 1) continue;
        const posixRel = rel.split(sep).join("/");
        if (posixRel === "SKILL.md") continue;
        if (!isSafeResourcePath(posixRel)) {
          log.warn(`skill resources: skipped an unsafe resource filename under ${canonicalDir}`);
          continue;
        }
        if (info.size > SKILL_RESOURCE_MAX_BYTES) continue;
        found.push(Object.freeze({ path: posixRel, bytes: info.size }));
      }
    }
    return found;
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
