export const UV_TARGETS = Object.freeze([
  Object.freeze({
    dir: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    bin: "uv",
    archive: "uv-aarch64-apple-darwin.tar.gz",
    archiveSha256: "162b328fc63e0075d4267688201de91356e1c1b81db50419fa4466cfe2dfdebc",
    type: "tar.gz",
  }),
  Object.freeze({
    dir: "win32-x64",
    platform: "win32",
    arch: "x64",
    bin: "uv.exe",
    archive: "uv-x86_64-pc-windows-msvc.zip",
    archiveSha256: "20d3a420abbf2af9699cd9a02225d9325344046af8deb15563cc451e3c4fd059",
    type: "zip",
  }),
  Object.freeze({
    dir: "linux-x64",
    platform: "linux",
    arch: "x64",
    bin: "uv",
    archive: "uv-x86_64-unknown-linux-gnu.tar.gz",
    archiveSha256: "17fc118ba4d7e9303f84fcabdc0a593fc3480ba76eb6980668fdbbb96fe88562",
    type: "tar.gz",
  }),
  Object.freeze({
    dir: "linux-arm64",
    platform: "linux",
    arch: "arm64",
    bin: "uv",
    archive: "uv-aarch64-unknown-linux-gnu.tar.gz",
    archiveSha256: "2c2be8bbb83e9bc722f2013de8bb7506cfe6521d0e30b4ad046849d036b3eea6",
    type: "tar.gz",
  }),
]);

for (const target of UV_TARGETS) {
  if (!/^[0-9a-f]{64}$/.test(target.archiveSha256)) {
    throw new Error(`UV_TARGETS malformed: ${target.dir} archiveSha256 is not lowercase 64-char hex`);
  }
}

export const UV_TARGET_BY_DIR = new Map(UV_TARGETS.map((target) => [target.dir, target]));
export const SUPPORTED_UV_TARGET_DIRS = Object.freeze(UV_TARGETS.map((target) => target.dir));

export function getUvTargetByDir(dir) {
  const target = UV_TARGET_BY_DIR.get(dir);
  if (!target) {
    throw new Error(`Unknown uv target '${dir}'. Known targets: ${SUPPORTED_UV_TARGET_DIRS.join(", ")}`);
  }
  return target;
}

export function resolveUvTarget(platform, arch) {
  const target = UV_TARGETS.find((item) => item.platform === platform && item.arch === arch);
  if (!target) {
    throw new Error(`지원하지 않는 플랫폼/아키텍처: ${platform}/${arch}`);
  }
  return target;
}

export function installerUvTargetFor(installerTarget, platform = process.platform, arch = process.arch) {
  if (installerTarget === "mac") {
    if (platform !== "darwin" || arch !== "arm64") {
      throw new Error("LVIS macOS installers support Apple Silicon only; Intel macOS builds are not supported.");
    }
    return { ...resolveUvTarget("darwin", "arm64"), archFlag: "--arm64" };
  }
  if (installerTarget === "linux") {
    const target = resolveUvTarget("linux", arch);
    return { ...target, archFlag: arch === "arm64" ? "--arm64" : "--x64" };
  }
  if (installerTarget === "win") {
    const target = resolveUvTarget("win32", arch);
    return { ...target, archFlag: "--x64" };
  }
  throw new Error(`Unknown installer target: ${installerTarget}`);
}
