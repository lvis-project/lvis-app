const { readFileSync, readdirSync, statSync } = require("node:fs");
const { isAbsolute, join, relative } = require("node:path");

function requireFile(path) {
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info?.isFile() || info.size === 0) throw new Error(`packaged image runtime file missing or empty: ${path}`);
  return path;
}

function packageFile(directory, path) {
  if (typeof path !== "string" || isAbsolute(path)) throw new Error("invalid image runtime package export");
  const target = join(directory, path);
  if (relative(directory, target).startsWith("..")) throw new Error("image runtime package export escaped its package");
  return requireFile(target);
}

/** Validate the target's physical packages without loading a foreign native addon. */
function assertImageRuntimeFiles(nodeModules, platform, arch) {
  const target = `${platform}-${arch}`;
  if (!/^(?:linux|darwin|win32)-(?:x64|arm64)$/.test(target)) throw new Error(`unsupported image runtime target: ${target}`);
  const wrapper = join(nodeModules, "sharp");
  const wrapperPackage = JSON.parse(readFileSync(requireFile(join(wrapper, "package.json")), "utf8"));
  packageFile(wrapper, wrapperPackage.main);
  const native = join(nodeModules, "@img", `sharp-${target}`);
  const nativePackage = JSON.parse(readFileSync(requireFile(join(native, "package.json")), "utf8"));
  if (nativePackage.name !== `@img/sharp-${target}`) throw new Error(`wrong image runtime package for ${target}`);
  packageFile(native, nativePackage.exports["./sharp.node"]);
  const bindings = readdirSync(join(native, "lib")).filter((name) => name.endsWith(".node"));
  if (bindings.length !== 1) throw new Error(`packaged image runtime requires one native binding for ${target}`);
  requireFile(join(native, "lib", bindings[0]));
  if (platform !== "win32") {
    const library = join(nodeModules, "@img", `sharp-libvips-${target}`);
    const libraryPackage = JSON.parse(readFileSync(requireFile(join(library, "package.json")), "utf8"));
    if (libraryPackage.name !== `@img/sharp-libvips-${target}`) throw new Error(`wrong image library package for ${target}`);
    packageFile(library, libraryPackage.exports["./binary"]);
  }
}

module.exports = { assertImageRuntimeFiles };
