import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { PluginContributionDeclaration, PluginManifest } from "./types.js";
import { verifyInstallReceiptRaw } from "./plugin-install-receipt.js";

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

type ContributionManifest = Pick<
  PluginManifest,
  "id" | "version" | "skills" | "hooks" | "mcpServers"
> & Partial<Pick<PluginManifest, "tools" | "emittedEvents">>;

/** Pure declaration validation shared by manifest load, packaging, and install. */
export function resolvePluginContributionDeclarations(
  manifest: ContributionManifest,
): readonly ResolvedPluginContribution[] {
  const resolved: ResolvedPluginContribution[] = [];
  const pathOwners = new Map<string, string>();
  const identifierOwners = new Map<string, string>([
    [manifest.id, `plugin:${manifest.id}`],
    ...(manifest.tools ?? []).map((tool) => [tool.name, `tool:${tool.name}`] as const),
    ...(manifest.emittedEvents ?? []).map((event) => [event, `event:${event}`] as const),
  ]);
  for (const [kind, declarations] of declarationsFor(manifest)) {
    if (declarations.length > MAX_DECLARATIONS_PER_KIND) {
      fail("too_many_declarations", manifest.id, kind);
    }
    for (const declaration of declarations) {
      const label = `${kind}:${String(declaration?.id)}`;
      if (!declaration || !LOCAL_ID_RE.test(declaration.id) || declaration.id.length > 128) {
        fail("invalid_local_id", manifest.id, label);
      }
      const identifierOwner = identifierOwners.get(declaration.id);
      if (identifierOwner) {
        const code = /^(?:skill|hook|mcpServer):/.test(identifierOwner)
          ? "duplicate_local_id"
          : "reserved_identifier_collision";
        fail(code, manifest.id, label, identifierOwner);
      }
      identifierOwners.set(declaration.id, label);
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
  manifest: ContributionManifest,
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
      if (inventory.get(key) === "file") {
        fail("declared_directory_wrong_kind", manifest.id, `${declaration.kind}:${declaration.localId}`, declaration.path);
      }
      const hasDirectory = inventory.get(key) === "directory" || [...inventory.keys()].some((entry) => entry.startsWith(`${key}/`));
      if (!hasDirectory) fail("declared_directory_missing", manifest.id, `${declaration.kind}:${declaration.localId}`, declaration.path);
      if (inventory.get(skillFile) !== "file") fail("skill_entry_missing", manifest.id, `${declaration.kind}:${declaration.localId}`, `${declaration.path}/SKILL.md`);
    } else {
      if (inventory.get(key) === "directory") {
        fail("declared_file_wrong_kind", manifest.id, `${declaration.kind}:${declaration.localId}`, declaration.path);
      }
      if (inventory.get(key) !== "file") {
        fail("declared_file_missing", manifest.id, `${declaration.kind}:${declaration.localId}`, declaration.path);
      }
      const undeclaredChild = [...inventory.keys()].find((entry) => entry.startsWith(`${key}/`));
      if (undeclaredChild) {
        fail("undeclared_contribution_file", manifest.id, `${declaration.kind}:${declaration.localId}`, undeclaredChild);
      }
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
  manifest: ContributionManifest,
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
      const bytes = await readFile(resolve(pluginRoot, path));
      files.push(Object.freeze({
        path,
        content: bytes.toString("utf8"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }));
    }
    const fingerprint = createHash("sha256")
      .update(files.map((file) => `${file.path}\0${file.sha256}`).join("\n"))
      .digest("hex");
    output.push(Object.freeze({ ...declaration, fingerprint, files: Object.freeze(files) }));
  }
  return Object.freeze(output);
}

/**
 * Copy only receipt-covered package bytes into a generation-addressed cache.
 * The resulting root never includes the plugin's mutable `data/` directory and
 * is verified against the exact receipt before it becomes executable input for
 * bundled Hook or stdio MCP projections.
 */
export async function materializePluginGenerationRoot(
  pluginRoot: string,
  cacheRoot: string,
  pluginId: string,
  generationId: string,
  receiptRaw: string,
): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(generationId)) throw new Error("plugin generation id must be a SHA-256 digest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(receiptRaw) as unknown;
  } catch (error) {
    throw new Error(`plugin '${pluginId}' install receipt is not valid JSON: ${(error as Error).message}`);
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`plugin '${pluginId}' install receipt has no payload files`);
  }

  const generationsRoot = resolve(cacheRoot, pluginId, "generations");
  const finalRoot = resolve(generationsRoot, generationId);
  const finalPayload = resolve(finalRoot, "payload");
  try {
    const existing = await verifyInstallReceiptRaw(receiptRaw, pluginId, finalPayload);
    if (existing.ok) return finalPayload;
    await lstat(finalRoot);
    throw new Error(`plugin '${pluginId}' retained generation failed verification: ${existing.reason}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(generationsRoot, { recursive: true, mode: 0o700 });
  const temporaryRoot = resolve(generationsRoot, `.${generationId}.${randomUUID()}.tmp`);
  const temporaryPayload = resolve(temporaryRoot, "payload");
  try {
    await mkdir(temporaryPayload, { recursive: true, mode: 0o700 });
    const pluginRootReal = await realpath(pluginRoot);
    for (const entry of files) {
      const path = (entry as { path?: unknown } | null)?.path;
      if (typeof path !== "string") throw new Error(`plugin '${pluginId}' install receipt contains an invalid path`);
      const relativePath = normalizePluginContributionPath(pluginId, `receipt:${path}`, path);
      const source = resolve(pluginRoot, relativePath);
      const sourceInfo = await lstat(source);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.nlink > 1) {
        throw new Error(`plugin '${pluginId}' retained generation source is not a regular unlinked file: ${relativePath}`);
      }
      const sourceReal = await realpath(source);
      const sourceRelative = relative(pluginRootReal, sourceReal);
      if (sourceRelative.startsWith("..") || isAbsolute(sourceRelative)) {
        throw new Error(`plugin '${pluginId}' retained generation source escapes plugin root: ${relativePath}`);
      }
      const destination = resolve(temporaryPayload, relativePath);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
    }
    const verified = await verifyInstallReceiptRaw(receiptRaw, pluginId, temporaryPayload);
    if (!verified.ok) throw new Error(`plugin '${pluginId}' retained generation verification failed: ${verified.reason}`);
    try {
      await rename(temporaryRoot, finalRoot);
    } catch (error) {
      if (!(["EEXIST", "ENOTEMPTY"] as Array<string | undefined>).includes((error as NodeJS.ErrnoException).code)) {
        throw error;
      }
      const raced = await verifyInstallReceiptRaw(receiptRaw, pluginId, finalPayload);
      if (!raced.ok) throw new Error(`plugin '${pluginId}' concurrent retained generation failed verification: ${raced.reason}`);
    }
    return finalPayload;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function removeRetainedPluginGeneration(
  cacheRoot: string,
  pluginId: string,
  generationId: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(generationId)) throw new Error("plugin generation id must be a SHA-256 digest");
  const generationsRoot = resolve(cacheRoot, pluginId, "generations");
  const target = resolve(generationsRoot, generationId);
  if (dirname(target) !== generationsRoot) throw new Error("retained plugin generation path escaped cache root");
  await rm(target, { recursive: true, force: true });
}
