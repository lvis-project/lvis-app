const { rmSync } = require("node:fs");
const { join } = require("node:path");

const LINUX_GPU_RUNTIME_FILES = [
  "libEGL.so",
  "libGLESv2.so",
  "libvk_swiftshader.so",
  "libvulkan.so.1",
  "vk_swiftshader_icd.json",
];

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;

  for (const file of LINUX_GPU_RUNTIME_FILES) {
    rmSync(join(context.appOutDir, file), { force: true });
  }
};
