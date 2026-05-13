const { rmSync } = require("node:fs");
const { join } = require("node:path");

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

module.exports = async function afterPack(context) {
  const keepWebgl = process.env.LVIS_KEEP_WEBGL === "1";

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
