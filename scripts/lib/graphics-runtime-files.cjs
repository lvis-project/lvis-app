const { statSync } = require("node:fs");
const { join } = require("node:path");

// These libraries support the selected rendering mode and its native fallback
// paths. A default software-rendering preference does not make them optional.
const GRAPHICS_RUNTIME_FILES = {
  linux: [
    "libEGL.so",
    "libGLESv2.so",
    "libvk_swiftshader.so",
    "libvulkan.so.1",
    "vk_swiftshader_icd.json",
  ],
  darwin: [
    "libEGL.dylib",
    "libGLESv2.dylib",
    "libvk_swiftshader.dylib",
    "vk_swiftshader_icd.json",
  ],
  win32: [
    "libEGL.dll",
    "libGLESv2.dll",
    "vk_swiftshader.dll",
    "vulkan-1.dll",
    "vk_swiftshader_icd.json",
    "dxcompiler.dll",
    "dxil.dll",
  ],
};

function assertGraphicsRuntimeFiles(libraryDirectory, platform) {
  if (!Object.hasOwn(GRAPHICS_RUNTIME_FILES, platform)) {
    throw new Error(`unsupported graphics runtime platform: ${platform}`);
  }
  const requiredFiles = GRAPHICS_RUNTIME_FILES[platform];
  for (const file of requiredFiles) {
    const path = join(libraryDirectory, file);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size === 0) {
      throw new Error(`packaged graphics runtime file missing or empty: ${path}`);
    }
  }
}

module.exports = { assertGraphicsRuntimeFiles };
