import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";

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
  writeUtf8FileAtomicSync(path, `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
}

export async function verifyInstallReceipt(
  cacheRoot: string,
  pluginId: string,
  pluginRoot: string,
): Promise<{ ok: true; receipt: PluginInstallReceipt } | { ok: false; reason: string }> {
  let parsed: PluginInstallReceiptV1 | PluginInstallReceipt;
  try {
    const raw = await readFile(installReceiptPath(cacheRoot, pluginId), "utf-8");
    parsed = JSON.parse(raw) as PluginInstallReceiptV1 | PluginInstallReceipt;
  } catch (err) {
    return { ok: false, reason: `install receipt missing or unreadable: ${(err as Error).message}` };
  }

  // Normalise v1 → v2.
  // v1 receipts with signerKeyId starting with "dev:" were written by the
  // old installLocal sentinel — treat them as local-dev installs.
  let receipt: PluginInstallReceipt;
  if (parsed.schemaVersion === 1) {
    const v1 = parsed as PluginInstallReceiptV1;
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
  } else if (parsed.schemaVersion === 2) {
    const v2 = parsed as PluginInstallReceipt;
    // Runtime enum validation — JSON.parse+as-cast cannot enforce union literals.
    if (v2.installSource !== "marketplace" && v2.installSource !== "local-dev") {
      return { ok: false, reason: `invalid receipt installSource: ${String(v2.installSource)}` };
    }
    receipt = v2;
  } else {
    return { ok: false, reason: `unsupported install receipt schema: ${String((parsed as { schemaVersion?: unknown }).schemaVersion)}` };
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
  for (const file of receipt.files) {
    const relPath = normalizeReceiptPath(file.path);
    if (!relPath || relPath !== file.path) {
      return { ok: false, reason: `invalid receipt path: ${String(file.path)}` };
    }
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
  return { ok: true, receipt };
}

export async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = resolve(dir, entry.name as string);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        out.push(relative(root, abs).split(sep).join("/"));
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
