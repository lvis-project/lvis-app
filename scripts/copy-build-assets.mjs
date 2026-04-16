import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);

if (args.length === 0 || args.length % 2 !== 0) {
  throw new Error("Usage: node copy-build-assets.mjs <src1> <dest1> [<src2> <dest2> ...]");
}

for (let i = 0; i < args.length; i += 2) {
  const src = resolve(process.cwd(), args[i]);
  const dest = resolve(process.cwd(), args[i + 1]);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}
