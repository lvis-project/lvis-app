import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("plugin-install-receipt");

export interface InstallReceiptFile {
  path: string;
  sha256: string;
}

/**
 * Schema v2 — written by all new installs.
 * installSource is the authoritative trust signal; signerKeyId / artifactSha256
 * are null for local-dev installs (no signed artifact to validate against).
 */
export interface PluginInstallReceipt {
  schemaVersion: 2;
  pluginId: string;
  version: string;
  installSource: "marketplace" | "local-dev";
  artifactSha256: string | null;
  signerKeyId: string | null;
  installedAt: string;
  files: InstallReceiptFile[];
}

/**
 * On-disk shape of receipts written before schema v2.
 * verifyInstallReceipt normalises these to PluginInstallReceipt internally.
 */
interface PluginInstallReceiptV1 {
  schemaVersion: 1;
  pluginId: string;
  version: string;
  artifactSha256: string;
  signerKeyId: string;
  installedAt: string;
  files: InstallReceiptFile[];
}

export function installReceiptPath(cacheRoot: string, pluginId: string): string {
  return resolve(cacheRoot, pluginId, "install-receipt.json");
}

export async function hashReceiptFiles(
  pluginRoot: string,
  files: string[],
): Promise<InstallReceiptFile[]> {
  const unique = [...new Set(files.map(normalizeReceiptPath).filter(Boolean))].sort();
  const out: InstallReceiptFile[] = [];
  for (const relPath of unique) {
    const absPath = resolve(pluginRoot, relPath);
    if (!isContained(pluginRoot, absPath)) {
      throw new Error(`receipt file escapes plugin root: ${relPath}`);
    }
    const bytes = await readFile(absPath);
    out.push({
      path: relPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return out;
}

export async function writeInstallReceipt(
  cacheRoot: string,
  receipt: PluginInstallReceipt,
): Promise<void> {
  const path = installReceiptPath(cacheRoot, receipt.pluginId);
  const content = serializeInstallReceipt(receipt);
  await writeInstallReceiptContent(path, receipt.pluginId, content);
}

export function serializeInstallReceipt(receipt: PluginInstallReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export async function buildInstallReceipt(
  pluginRoot: string,
  input: {
    pluginId: string;
    version: string;
    installSource: "marketplace" | "local-dev";
    artifactSha256: string | null;
    signerKeyId: string | null;
    files: string[];
    installedAt?: string;
  },
): Promise<{ receipt: PluginInstallReceipt; raw: string }> {
  const receipt: PluginInstallReceipt = {
    schemaVersion: 2,
    pluginId: input.pluginId,
    version: input.version,
    installSource: input.installSource,
    artifactSha256: input.artifactSha256,
    signerKeyId: input.signerKeyId,
    installedAt: input.installedAt ?? new Date().toISOString(),
    files: await hashReceiptFiles(pluginRoot, input.files),
  };
  return { receipt, raw: serializeInstallReceipt(receipt) };
}

/** Restore an already-validated receipt snapshot without changing its bytes. */
export async function restoreInstallReceiptRaw(
  cacheRoot: string,
  pluginId: string,
  content: string,
): Promise<void> {
  await writeInstallReceiptContent(installReceiptPath(cacheRoot, pluginId), pluginId, content);
}

async function writeInstallReceiptContent(
  path: string,
  pluginId: string,
  content: string,
): Promise<void> {
  try {
    writeUtf8FileAtomicSync(path, content, 0o600);
  } catch (error) {
    if (!(error instanceof Error) || (error as { committed?: unknown }).committed !== true) throw error;
    const persisted = await readFile(path, "utf-8");
    if (persisted !== content) throw error;
    log.warn(
      `install receipt atomic rename committed for '${pluginId}'; exact bytes verified after parent directory sync failure`,
    );
  }
}

export async function verifyInstallReceipt(
  cacheRoot: string,
  pluginId: string,
  pluginRoot: string,
): Promise<{ ok: true; receipt: PluginInstallReceipt } | { ok: false; reason: string }> {
  let raw: string;
  try {
    raw = await readFile(installReceiptPath(cacheRoot, pluginId), "utf-8");
  } catch (err) {
    return { ok: false, reason: `install receipt missing or unreadable: ${(err as Error).message}` };
  }
  return verifyInstallReceiptRaw(raw, pluginId, pluginRoot);
}

/** Verify an exact durable receipt snapshot against every covered payload file. */
export async function verifyInstallReceiptRaw(
  raw: string,
  pluginId: string,
  pluginRoot: string,
): Promise<{ ok: true; receipt: PluginInstallReceipt } | { ok: false; reason: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return { ok: false, reason: `install receipt unreadable: ${(err as Error).message}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "install receipt must be a JSON object" };
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.pluginId !== "string"
    || typeof candidate.version !== "string"
    || candidate.version.length === 0
    || typeof candidate.installedAt !== "string"
    || !Array.isArray(candidate.files)
    || candidate.files.length === 0) {
    return { ok: false, reason: "install receipt has invalid required fields" };
  }
  for (const file of candidate.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)
      || typeof (file as Record<string, unknown>).path !== "string"
      || typeof (file as Record<string, unknown>).sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test((file as Record<string, unknown>).sha256 as string)) {
      return { ok: false, reason: "install receipt has invalid file hash entries" };
    }
  }

  // Normalise v1 → v2.
  // v1 receipts with signerKeyId starting with "dev:" were written by the
  // old installLocal sentinel — treat them as local-dev installs.
  let receipt: PluginInstallReceipt;
  if (candidate.schemaVersion === 1) {
    const v1 = candidate as unknown as PluginInstallReceiptV1;
    if (typeof v1.artifactSha256 !== "string") {
      return { ok: false, reason: "legacy install receipt has invalid artifactSha256" };
    }
    // Guard against corrupted receipts where signerKeyId is missing at runtime.
    const rawSigner = (v1 as { signerKeyId?: unknown }).signerKeyId;
    const installSource: "marketplace" | "local-dev" =
      typeof rawSigner === "string" && rawSigner.startsWith("dev:") ? "local-dev" : "marketplace";
    receipt = {
      schemaVersion: 2,
      pluginId: v1.pluginId,
      version: v1.version,
      installSource,
      artifactSha256: installSource === "local-dev" ? null : v1.artifactSha256,
      signerKeyId: installSource === "local-dev" ? null : (typeof rawSigner === "string" ? rawSigner : null),
      installedAt: v1.installedAt,
      files: v1.files,
    };
  } else if (candidate.schemaVersion === 2) {
    const v2 = candidate as unknown as PluginInstallReceipt;
    // Runtime enum validation — JSON.parse+as-cast cannot enforce union literals.
    if (v2.installSource !== "marketplace" && v2.installSource !== "local-dev") {
      return { ok: false, reason: `invalid receipt installSource: ${String(v2.installSource)}` };
    }
    receipt = v2;
  } else {
    return { ok: false, reason: `unsupported install receipt schema: ${String(candidate.schemaVersion)}` };
  }

  if (receipt.pluginId !== pluginId) {
    return { ok: false, reason: `install receipt plugin mismatch: expected ${pluginId}, got ${receipt.pluginId}` };
  }

  // marketplace receipts must carry a real signerKeyId.
  // The packaged-build gate for local-dev receipts lives in the caller
  // (runtime/index.ts verifyReceiptAndDevGuard) to keep this function a
  // pure integrity verifier — policy enforcement stays in the runtime layer.
  if (receipt.installSource === "marketplace") {
    if (typeof receipt.signerKeyId !== "string" || receipt.signerKeyId.length === 0) {
      return { ok: false, reason: "marketplace receipt missing or empty signerKeyId" };
    }
  }

  if (!Array.isArray(receipt.files) || receipt.files.length === 0) {
    return { ok: false, reason: "install receipt has no file hashes" };
  }
  const receiptPaths = new Set<string>();
  for (const file of receipt.files) {
    const relPath = normalizeReceiptPath(file.path);
    if (!relPath || relPath !== file.path) {
      return { ok: false, reason: `invalid receipt path: ${String(file.path)}` };
    }
    if (receiptPaths.has(relPath)) {
      return { ok: false, reason: `duplicate receipt path: ${relPath}` };
    }
    receiptPaths.add(relPath);
    const absPath = resolve(pluginRoot, relPath);
    if (!isContained(pluginRoot, absPath)) {
      return { ok: false, reason: `receipt file escapes plugin root: ${relPath}` };
    }
    let actual: string;
    try {
      const bytes = await readFile(absPath);
      actual = createHash("sha256").update(bytes).digest("hex");
    } catch (err) {
      return { ok: false, reason: `receipt file unreadable: ${relPath}: ${(err as Error).message}` };
    }
    if (actual !== file.sha256) {
      return { ok: false, reason: `receipt hash mismatch: ${relPath}` };
    }
  }
  let actualPaths: string[];
  try {
    actualPaths = await listFilesRecursive(pluginRoot);
  } catch (err) {
    return { ok: false, reason: `installed payload unreadable: ${(err as Error).message}` };
  }
  if (actualPaths.length !== receiptPaths.size
    || actualPaths.some((path) => !receiptPaths.has(path))) {
    const unexpected = actualPaths.find((path) => !receiptPaths.has(path));
    return { ok: false, reason: unexpected
      ? `installed payload contains unlisted file: ${unexpected}`
      : "install receipt file set does not match installed payload" };
  }
  return { ok: true, receipt };
}

export async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = resolve(dir, entry.name as string);
      const info = await lstat(abs);
      if (info.isSymbolicLink()) {
        throw new Error(`installed payload contains symbolic link: ${relative(root, abs).split(sep).join("/")}`);
      }
      if (info.isDirectory()) {
        await walk(abs);
      } else if (info.isFile()) {
        if (info.nlink > 1) {
          throw new Error(`installed payload contains hard link: ${relative(root, abs).split(sep).join("/")}`);
        }
        out.push(relative(root, abs).split(sep).join("/"));
      } else {
        throw new Error(`installed payload contains unsupported entry: ${relative(root, abs).split(sep).join("/")}`);
      }
    }
  }
  await walk(root);
  return out.sort();
}

function normalizeReceiptPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || isAbsolute(normalized)) return "";
  return normalized;
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !rel.startsWith("..") && !isAbsolute(rel);
}
