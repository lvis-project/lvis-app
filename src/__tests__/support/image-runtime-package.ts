import { writeFixtureFile } from "../../../test/scripts/gate-script-runner.js";

/** Package shape for filesystem checks; these bytes are not executable addons. */
export function writeImageRuntimePackage(nodeModules: string, platform: string, arch = "x64"): void {
  const target = `${platform}-${arch}`;
  writeFixtureFile(nodeModules, "sharp/package.json", JSON.stringify({ main: "dist/index.cjs" }));
  writeFixtureFile(nodeModules, "sharp/dist/index.cjs", "runtime wrapper");
  writeFixtureFile(nodeModules, `@img/sharp-${target}/package.json`, JSON.stringify({
    name: `@img/sharp-${target}`, exports: { "./sharp.node": "./index.cjs" },
  }));
  writeFixtureFile(nodeModules, `@img/sharp-${target}/index.cjs`, "addon loader");
  writeFixtureFile(nodeModules, `@img/sharp-${target}/lib/runtime.node`, "native addon fixture");
  if (platform !== "win32") {
    writeFixtureFile(nodeModules, `@img/sharp-libvips-${target}/package.json`, JSON.stringify({
      name: `@img/sharp-libvips-${target}`, exports: { "./binary": "./lib/runtime-library" },
    }));
    writeFixtureFile(nodeModules, `@img/sharp-libvips-${target}/lib/runtime-library`, "codec library fixture");
  }
}
