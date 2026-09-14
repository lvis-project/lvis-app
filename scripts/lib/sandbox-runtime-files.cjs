const { lstatSync } = require("node:fs");
const { join } = require("node:path");

function assertSandboxRuntimeFiles(vendorDirectory, platform) {
  if (platform !== "darwin" && platform !== "linux") return;
  const path = join(vendorDirectory, "java-proxy-agent", "srt-proxy-agent.jar");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size === 0) {
    throw new Error(`packaged JVM proxy agent missing or invalid: ${path}`);
  }
}

module.exports = { assertSandboxRuntimeFiles };
