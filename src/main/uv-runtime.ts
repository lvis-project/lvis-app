import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { resolveUvTarget, type UvTarget } from "../../scripts/uv-targets.mjs";
import { lvisHome } from "../shared/lvis-home.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function defaultRuntimeUvDir(): string {
  return path.join(lvisHome(), "runtime", "uv");
}

export interface BundledUvRuntimeOptions {
  defaultApp?: boolean;
  resourcesPath?: string;
  moduleDir?: string;
  uvRuntimeDir?: string;
  requireDevBinary?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
}

export function isPackagedUvRuntime(options: BundledUvRuntimeOptions = {}): boolean {
  const defaultApp = options.defaultApp ?? (process as { defaultApp?: boolean }).defaultApp;
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  return !defaultApp && !!resourcesPath;
}

export function currentUvTarget(options: BundledUvRuntimeOptions = {}): UvTarget {
  return resolveUvTarget(options.platform ?? process.platform, options.arch ?? process.arch);
}

export function resolveBundledUvBinaryPath(options: BundledUvRuntimeOptions = {}): string {
  const uvTarget = currentUvTarget(options);
  if (!isPackagedUvRuntime(options)) {
    return resolveDevUvBinaryPath(uvTarget, options);
  }
  return materializePackagedUvBinary(uvTarget, options);
}

function resolveDevUvBinaryPath(uvTarget: UvTarget, options: BundledUvRuntimeOptions): string {
  const moduleDir = options.moduleDir ?? __dirname;
  const candidates = [
    path.join(moduleDir, "..", "..", "..", "resources", "uv", uvTarget.dir, uvTarget.bin),
    path.join(moduleDir, "..", "..", "resources", "uv", uvTarget.dir, uvTarget.bin),
  ];
  if (options.requireDevBinary === false) {
    return candidates[0];
  }

  const uvPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!uvPath) {
    throw new Error(
      `bundled uv binary not found. Checked: ${candidates.join(", ")}. ` +
        `Run "npm run postinstall" or "node scripts/fetch-uv.mjs" first.`,
    );
  }
  return uvPath;
}

function materializePackagedUvBinary(uvTarget: UvTarget, options: BundledUvRuntimeOptions): string {
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  if (!resourcesPath) {
    throw new Error("packaged uv resources path is unavailable");
  }

  const packagedDir = path.join(resourcesPath, "uv", uvTarget.dir);
  const compressedBin = path.join(packagedDir, `${uvTarget.bin}.gz`);
  const metaPath = path.join(packagedDir, "uv.meta.json");
  const { binarySha256 } = readPackagedUvMetadata(metaPath);
  const runtimeUvDir = options.uvRuntimeDir ?? defaultRuntimeUvDir();
  const targetDir = path.join(runtimeUvDir, uvTarget.dir, binarySha256);
  const targetBin = path.join(targetDir, uvTarget.bin);

  if (fs.existsSync(targetBin)) {
    const cachedBinary = fs.readFileSync(targetBin);
    if (sha256Hex(cachedBinary) === binarySha256) return targetBin;
    fs.unlinkSync(targetBin);
  }
  if (!fs.existsSync(compressedBin)) {
    throw new Error(`packaged uv archive not found: ${compressedBin}`);
  }

  const binaryBytes = gunzipSync(fs.readFileSync(compressedBin));
  const actualBinarySha256 = sha256Hex(binaryBytes);
  if (actualBinarySha256 !== binarySha256) {
    throw new Error(
      `packaged uv binary SHA mismatch: expected ${binarySha256}, got ${actualBinarySha256}: ${compressedBin}`,
    );
  }

  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  if ((options.platform ?? process.platform) !== "win32") {
    fs.chmodSync(runtimeUvDir, 0o700);
    fs.chmodSync(path.dirname(targetDir), 0o700);
    fs.chmodSync(targetDir, 0o700);
  }
  fs.writeFileSync(targetBin, binaryBytes, { mode: 0o600 });
  if ((options.platform ?? process.platform) !== "win32") {
    fs.chmodSync(targetBin, 0o700);
  }
  return targetBin;
}

function readPackagedUvMetadata(metaPath: string): { binarySha256: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch (err) {
    throw new Error(`packaged uv metadata missing or unreadable: ${metaPath}: ${(err as Error).message}`);
  }

  const binarySha256 = (parsed as { binarySha256?: unknown }).binarySha256;
  if (typeof binarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(binarySha256)) {
    throw new Error(`packaged uv metadata has invalid binarySha256: ${metaPath}`);
  }
  return { binarySha256 };
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
