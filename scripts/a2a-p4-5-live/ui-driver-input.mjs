import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { fail } from "./evidence-lib.mjs";

export function resolveCanonicalUiManifestPath(candidate, { cwd = process.cwd() } = {}) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) {
    fail("UI driver manifest path is invalid");
  }
  const lexicalPath = resolve(cwd, candidate);
  let canonicalPath;
  try {
    canonicalPath = realpathSync(lexicalPath);
  } catch (error) {
    fail(`UI driver manifest path cannot be resolved (${error.message})`);
  }
  if (canonicalPath !== lexicalPath) fail("UI driver manifest path must be canonical");
  return canonicalPath;
}
