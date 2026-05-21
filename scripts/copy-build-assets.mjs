import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveBuildAssets } from "./lib/build-assets.mjs";

const args = process.argv.slice(2);

if (args.length % 2 !== 0) {
  throw new Error("Usage: node copy-build-assets.mjs <src1> <dest1> [<src2> <dest2> ...]");
}

const assets =
  args.length === 0
    ? resolveBuildAssets(process.cwd())
    : Array.from({ length: args.length / 2 }, (_, index) => {
        const offset = index * 2;
        return {
          src: resolve(process.cwd(), args[offset]),
          out: resolve(process.cwd(), args[offset + 1]),
          label: args[offset],
        };
      });

for (const asset of assets) {
  mkdirSync(dirname(asset.out), { recursive: true });
  copyFileSync(asset.src, asset.out);
}
