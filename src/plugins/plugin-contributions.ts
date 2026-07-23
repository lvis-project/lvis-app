import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { PluginContributionDeclaration, PluginManifest } from "./types.js";

export type PluginContributionKind = "skill" | "hook" | "mcpServer";
export type PluginArchiveMemberKind = "file" | "directory" | "symlink" | "hardlink" | "device" | "other";

export interface PluginArchiveMember {
  path: string;
  kind: PluginArchiveMemberKind;
}

export interface PluginContributionIdentity {
  ownerPluginId: string;
  ownerVersion: string;
  kind: PluginContributionKind;
  localId: string;
}

export interface ResolvedPluginContribution extends PluginContributionIdentity {
  path: string;
}

export interface MaterializedContributionFile {
  path: string;
  content: string;
  sha256: string;
}

export interface MaterializedPluginContribution extends ResolvedPluginContribution {
  fingerprint: string;
  files: readonly MaterializedContributionFile[];
}

const LOCAL_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_DECLARATIONS_PER_KIND = 64;
const AMBIGUOUS_PERCENT_ENCODING_RE = /%(?:2e|2f|5c)/i;

export class PluginContributionError extends Error {
  constructor(
    readonly code: string,
    readonly pluginId: string,
    readonly contribution: string,
    readonly safePath?: string,
  ) {
    super(`[plugin:${pluginId}] contribution '${contribution}' failed ${code}${safePath ? `: ${safePath}` : ""}`);
    this.name = "PluginContributionError";
  }
}

function fail(code: string, pluginId: string, contribution: string, safePath?: string): never {
  throw new PluginContributionError(code, pluginId, contribution, safePath);
}

/** Validate and return one canonical plugin-root-relative POSIX path. */
export function normalizePluginContributionPath(
  pluginId: string,
  contribution: string,
  input: string,
): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 512 ||
    input !== input.normalize("NFC") ||
    input.includes("\0") ||
    /[\u0000-\u001f\u007f]/.test(input) ||
    input.includes("\\") ||
    input.startsWith("/") ||
    input.startsWith("//") ||
    /^[A-Za-z]:/.test(input) ||
    isAbsolute(input) ||
    AMBIGUOUS_PERCENT_ENCODING_RE.test(input)
  ) {
    // Do not echo an absolute host path (or control-bearing input) into logs.
    fail("invalid_path", pluginId, contribution);
  }
  const segments = input.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("invalid_path_segment", pluginId, contribution, input);
  }
  const normalized = posix.normalize(input);
  if (normalized !== input || normalized === ".." || normalized.startsWith("../")) {
    fail("path_escape", pluginId, contribution, input);
  }
  return normalized;
}

function declarationsFor(manifest: Pick<PluginManifest, "skills" | "hooks" | "mcpServers">): Array<[PluginContributionKind, PluginContributionDeclaration[]]> {
  return [
    ["skill", manifest.skills ?? []],
    ["hook", manifest.hooks ?? []],
    ["mcpServer", manifest.mcpServers ?? []],
  ];
}

/** Pure declaration validation shared by manifest load, packaging, and install. */
export function resolvePluginContributionDeclarations(
  manifest: Pick<PluginManifest, "id" | "version" | "skills" | "hooks" | "mcpServers">,
): readonly ResolvedPluginContribution[] {
  const resolved: ResolvedPluginContribution[] = [];
  const pathOwners = new Map<string, string>();
  for (const [kind, declarations] of declarationsFor(manifest)) {
    if (declarations.length > MAX_DECLARATIONS_PER_KIND) {
      fail("too_many_declarations", manifest.id, kind);
    }
    const ids = new Set<string>();
    for (const declaration of declarations) {
      const label = `${kind}:${String(declaration?.id)}`;
      if (!declaration || !LOCAL_ID_RE.test(declaration.id) || declaration.id.length > 128) {
        fail("invalid_local_id", manifest.id, label);
      }
      if (ids.has(declaration.id)) fail("duplicate_local_id", manifest.id, label);
      ids.add(declaration.id);
      const path = normalizePluginContributionPath(manifest.id, label, declaration.path);
      const collisionKey = path.normalize("NFC").toLocaleLowerCase("en-US");
      for (const [existingPath, existingOwner] of pathOwners) {
        if (
          collisionKey === existingPath ||
          collisionKey.startsWith(`${existingPath}/`) ||
          existingPath.startsWith(`${collisionKey}/`)
        ) {
          fail("path_collision", manifest.id, label, `${path} conflicts with ${existingOwner}`);
        }
      }
      pathOwners.set(collisionKey, label);
      resolved.push(Object.freeze({
        ownerPluginId: manifest.id,
        ownerVersion: manifest.version,
        kind,
        localId: declaration.id,
        path,
      }));
    }
  }
  return Object.freeze(resolved);
}

function canonicalMemberPath(pluginId: string, rawPath: string): string {
  return normalizePluginContributionPath(pluginId, "archive", rawPath.replace(/\/$/, ""));
}

/** Validate declared contribution paths against an archive or installed-tree inventory. */
export function validatePluginContributionInventory(
  manifest: Pick<PluginManifest, "id" | "version" | "skills" | "hooks" | "mcpServers">,
  members: readonly PluginArchiveMember[],
): readonly ResolvedPluginContribution[] {
  const declarations = resolvePluginContributionDeclarations(manifest);
  const inventory = new Map<string, PluginArchiveMemberKind>();
  for (const member of members) {
    const path = canonicalMemberPath(manifest.id, member.path);
    const key = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (inventory.has(key)) fail("member_collision", manifest.id, "archive", path);
    if (member.kind === "symlink" || member.kind === "hardlink" || member.kind === "device" || member.kind === "other") {
      fail("unsupported_member_kind", manifest.id, "archive", path);
    }
    inventory.set(key, member.kind);
  }
  for (const declaration of declarations) {
    const key = declaration.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (declaration.kind === "skill") {
      const skillFile = `${key}/skill.md`;
      const hasDirectory = inventory.get(key) === "directory" || [...inventory.keys()].some((entry) => entry.startsWith(`${key}/`));
      if (!hasDirectory) fail("declared_directory_missing", manifest.id, `${declaration.kind}:${declaration.localId}`, declaration.path);
      if (inventory.get(skillFile) !== "file") fail("skill_entry_missing", manifest.id, `${declaration.kind}:${declaration.localId}`, `${declaration.path}/SKILL.md`);
    } else if (inventory.get(key) !== "file") {
      fail("declared_file_missing", manifest.id, `${declaration.kind}:${declaration.localId}`, declaration.path);
    }
  }
  return declarations;
}

async function inventoryInstalledRoot(root: string, pluginId: string): Promise<PluginArchiveMember[]> {
  const rootReal = await realpath(root);
  const members: PluginArchiveMember[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = resolve(dir, entry.name);
      const stat = await lstat(absolute);
      const path = relative(root, absolute).split(sep).join("/");
      if (stat.isSymbolicLink()) {
        members.push({ path, kind: "symlink" });
        continue;
      }
      const targetReal = await realpath(absolute);
      const rel = relative(rootReal, targetReal);
      if (rel.startsWith("..") || isAbsolute(rel)) fail("realpath_escape", pluginId, "archive", path);
      if (stat.isDirectory()) {
        members.push({ path, kind: "directory" });
        await walk(absolute);
      } else if (stat.isFile()) {
        members.push({ path, kind: stat.nlink > 1 ? "hardlink" : "file" });
      } else {
        members.push({ path, kind: "other" });
      }
    }
  }
  await walk(root);
  return members;
}

/** Read verified installed bytes into an immutable generation candidate. */
export async function materializePluginContributions(
  pluginRoot: string,
  manifest: Pick<PluginManifest, "id" | "version" | "skills" | "hooks" | "mcpServers">,
): Promise<readonly MaterializedPluginContribution[]> {
  const inventory = await inventoryInstalledRoot(pluginRoot, manifest.id);
  const declarations = validatePluginContributionInventory(manifest, inventory);
  const filePaths = inventory.filter((member) => member.kind === "file").map((member) => member.path);
  const output: MaterializedPluginContribution[] = [];
  for (const declaration of declarations) {
    const selected = declaration.kind === "skill"
      ? filePaths.filter((path) => path === declaration.path || path.startsWith(`${declaration.path}/`))
      : [declaration.path];
    const files: MaterializedContributionFile[] = [];
    for (const path of selected.sort()) {
      const content = await readFile(resolve(pluginRoot, path), "utf8");
      files.push(Object.freeze({ path, content, sha256: createHash("sha256").update(content).digest("hex") }));
    }
    const fingerprint = createHash("sha256")
      .update(files.map((file) => `${file.path}\0${file.sha256}`).join("\n"))
      .digest("hex");
    output.push(Object.freeze({ ...declaration, fingerprint, files: Object.freeze(files) }));
  }
  return Object.freeze(output);
}
