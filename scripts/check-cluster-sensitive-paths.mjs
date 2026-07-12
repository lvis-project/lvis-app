import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SENSITIVE_DIRS = Object.freeze([
  "src/permissions",
  "src/audit",
  "src/sandbox",
  "src/ipc",
  "src/preload",
  "src/boot",
  "src/core/permissions",
]);

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const BARE_SENSITIVE_PATHS = SENSITIVE_DIRS.map(
  (dir) => new RegExp(`^${dir.replaceAll("/", "\\/")}[^/]*\\.(?:ts|tsx|js|jsx)$`),
);

function isCanonicalGitPath(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return false;
  if (path.includes("\\") || CONTROL_CHARACTER.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isSensitiveClusterPath(path) {
  // Git emits canonical repository-relative paths here. Treat malformed input
  // as sensitive so a quoting or parsing regression cannot bypass the gate.
  if (!isCanonicalGitPath(path)) return true;

  return SENSITIVE_DIRS.some((dir, index) => {
    if (path.startsWith(`${dir}/`)) {
      return !path.startsWith(`${dir}/__tests__/`);
    }
    return BARE_SENSITIVE_PATHS[index].test(path);
  });
}

export function hasSensitiveClusterPath(paths) {
  return paths.some(isSensitiveClusterPath);
}

export function parseNulDelimitedGitPaths(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw new Error("git-path-input-missing-terminal-nul");

  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const paths = decoded.split("\0");
  paths.pop();
  if (paths.some((path) => path.length === 0)) {
    throw new Error("git-path-input-empty-record");
  }
  return paths;
}

function runFromStdin() {
  const paths = parseNulDelimitedGitPaths(readFileSync(0));
  console.log(hasSensitiveClusterPath(paths) ? "sensitive" : "clean");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromStdin();
}
