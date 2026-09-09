const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== "win32") return;
  if (process.platform !== "win32") throw new Error("Windows job launcher requires a native Windows build");
  const arch = { 1: "x64", 3: "arm64" }[context.arch];
  if (!arch) throw new Error(`Unsupported Windows job launcher architecture: ${context.arch}`);
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    join(context.packager.projectDir, "scripts", "build-windows-job.ps1"), "-Arch", arch], { stdio: "inherit" });
};
