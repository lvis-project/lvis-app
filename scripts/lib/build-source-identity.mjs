import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const generatedAssetChecker = fileURLToPath(new URL("../check-generated-assets.mjs", import.meta.url));
const ambientGitVariables = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX",
];

/**
 * Describe the committed build inputs and separately inventory encoder-only
 * generated output differences. `dirty` never exempts handwritten or untracked
 * files. The generator's manifest and its existing decoded-image checker own
 * which tracked outputs qualify; the packager consumes this same function.
 */
export function readBuildSourceIdentity(repoRoot) {
  const root = resolve(repoRoot);
  const env = { ...process.env };
  for (const name of ambientGitVariables) delete env[name];
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env });
  const splitPaths = (value) => value.split("\0").filter(Boolean);
  const changed = splitPaths(git("diff", "--name-only", "-z", "HEAD", "--"));
  const untracked = splitPaths(git("ls-files", "--others", "--exclude-standard", "-z"));
  const generatedOutputs = {};
  const manifestPath = resolve(root, "build/generated-assets.json");
  if (changed.length > 0 && existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(manifest) || manifest.some((path) =>
      typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).includes(".."))) {
      throw new Error("Invalid generated asset manifest for build identity");
    }
    const candidates = changed.filter((path) => manifest.includes(path));
    if (candidates.length > 0) {
      // Force the real comparison on every platform. A platform SKIP cannot
      // establish that a dirty image still depicts its committed source.
      const check = spawnSync(process.execPath, [generatedAssetChecker, "--root", root], {
        env: { ...env, LVIS_GENERATED_ASSETS_FORCE: "1" }, encoding: "utf8",
      });
      if (check.error) throw check.error;
      if (check.status === 0 && check.stdout.includes("[generated-assets] OK")) {
        for (const path of candidates.sort()) {
          const bytes = readFileSync(resolve(root, path));
          generatedOutputs[path] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
        }
      }
    }
  }
  return {
    commit: git("rev-parse", "HEAD").trim(),
    tree: git("rev-parse", "HEAD^{tree}").trim(),
    dirty: untracked.length > 0 || changed.some((path) => !Object.hasOwn(generatedOutputs, path)),
    generatedOutputs,
  };
}
