const { statSync } = require("node:fs");
const { join } = require("node:path");

// The rendering engine includes its EGL/GLES implementation in the executable.
// These separate libraries still support its native software-rendering paths
// and remain required regardless of the selected hardware-acceleration mode.
const GRAPHICS_RUNTIME_FILES = {
  linux: [
    "libvk_swiftshader.so",
    "libvulkan.so.1",
    "vk_swiftshader_icd.json",
  ],
  darwin: [
    "libvk_swiftshader.dylib",
    "vk_swiftshader_icd.json",
  ],
  win32: [
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
