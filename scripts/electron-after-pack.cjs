const { createHash } = require("node:crypto");
const { existsSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { gunzipSync } = require("node:zlib");

const LINUX_GPU_RUNTIME_FILES = [
  "libEGL.so",
  "libGLESv2.so",
  "libvk_swiftshader.so",
  "libvulkan.so.1",
  "vk_swiftshader_icd.json",
];

const MAC_WEBGL_FALLBACK_FILES = [
  "libvk_swiftshader.dylib",
  "libGLESv2.dylib",
  "libEGL.dylib",
  "vk_swiftshader_icd.json",
];

const WIN_WEBGL_FALLBACK_FILES = [
  "vk_swiftshader.dll",
  "libGLESv2.dll",
  "libEGL.dll",
  "vulkan-1.dll",
  "vk_swiftshader_icd.json",
];

function electronResourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    const productFilename = context.packager.appInfo.productFilename;
    return join(context.appOutDir, `${productFilename}.app`, "Contents", "Resources");
  }
  return join(context.appOutDir, "resources");
}

function assertBundledUvResource(context) {
  const resourcesDir = electronResourcesDir(context);
  const uvDir = join(resourcesDir, "uv");
  if (!existsSync(uvDir)) {
    throw new Error(`packaged uv resource missing: ${uvDir}`);
  }

  const uvTargets = readdirSync(uvDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (uvTargets.length !== 1) {
    throw new Error(`packaged uv resource must contain exactly one target; found ${uvTargets.join(", ")}`);
  }

  const uvTarget = uvTargets[0];
  const expectedPrefix = context.electronPlatformName === "win32" ? "win32-" : `${context.electronPlatformName}-`;
  if (!uvTarget.startsWith(expectedPrefix)) {
    throw new Error(`packaged uv target ${uvTarget} does not match ${context.electronPlatformName}`);
  }

  const uvTargetDir = join(uvDir, uvTarget);
  const uvBin = uvTarget.startsWith("win32-") ? "uv.exe" : "uv";
  const uvFiles = new Set(readdirSync(uvTargetDir));
  if (uvFiles.has(uvBin)) {
    throw new Error(`raw uv binary leaked into package: ${join(uvTargetDir, uvBin)}`);
  }
  if (!uvFiles.has(`${uvBin}.gz`)) {
    throw new Error(`compressed uv archive missing: ${join(uvTargetDir, `${uvBin}.gz`)}`);
  }
  if (!uvFiles.has("uv.meta.json")) {
    throw new Error(`packaged uv metadata missing: ${join(uvTargetDir, "uv.meta.json")}`);
  }
  const metaPath = join(uvTargetDir, "uv.meta.json");
  const compressedBin = join(uvTargetDir, `${uvBin}.gz`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  if (typeof meta.binarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(meta.binarySha256)) {
    throw new Error(`packaged uv metadata has invalid binarySha256: ${metaPath}`);
  }
  const actualBinarySha256 = sha256Hex(gunzipSync(readFileSync(compressedBin)));
  if (actualBinarySha256 !== meta.binarySha256) {
    throw new Error(
      `packaged uv binary SHA mismatch: expected ${meta.binarySha256}, got ${actualBinarySha256}: ${compressedBin}`,
    );
  }

  const uvLicense = join(resourcesDir, "licenses", "uv", "LICENSE-MIT");
  if (!existsSync(uvLicense)) {
    throw new Error(`uv license notice missing: ${uvLicense}`);
  }
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

module.exports = async function afterPack(context) {
  const keepWebgl = process.env.LVIS_KEEP_WEBGL === "1";
  assertBundledUvResource(context);

  if (context.electronPlatformName === "linux") {
    for (const file of LINUX_GPU_RUNTIME_FILES) {
      rmSync(join(context.appOutDir, file), { force: true });
    }
    return;
  }

  if (keepWebgl) return;

  if (context.electronPlatformName === "darwin") {
    const productFilename = context.packager.appInfo.productFilename;
    const frameworkLibs = join(
      context.appOutDir,
      `${productFilename}.app`,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Libraries",
    );
    for (const file of MAC_WEBGL_FALLBACK_FILES) {
      rmSync(join(frameworkLibs, file), { force: true });
    }
    return;
  }

  if (context.electronPlatformName === "win32") {
    for (const file of WIN_WEBGL_FALLBACK_FILES) {
      rmSync(join(context.appOutDir, file), { force: true });
    }
  }
};
