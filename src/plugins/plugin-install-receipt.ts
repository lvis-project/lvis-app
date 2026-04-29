import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface InstallReceiptFile {
  path: string;
  sha256: string;
}

export interface PluginInstallReceipt {
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
}

export async function verifyInstallReceipt(
  cacheRoot: string,
  pluginId: string,
  pluginRoot: string,
): Promise<{ ok: true; receipt: PluginInstallReceipt } | { ok: false; reason: string }> {
  let receipt: PluginInstallReceipt;
  try {
    const raw = await readFile(installReceiptPath(cacheRoot, pluginId), "utf-8");
    receipt = JSON.parse(raw) as PluginInstallReceipt;
  } catch (err) {
    return { ok: false, reason: `install receipt missing or unreadable: ${(err as Error).message}` };
  }
  if (receipt.schemaVersion !== 1) {
    return { ok: false, reason: `unsupported install receipt schema: ${String(receipt.schemaVersion)}` };
  }
  if (receipt.pluginId !== pluginId) {
    return { ok: false, reason: `install receipt plugin mismatch: expected ${pluginId}, got ${receipt.pluginId}` };
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
      const abs = resolve(dir, entry.name);
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
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || isAbsolute(normalized)) {
    return "";
  }
  return normalized;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
