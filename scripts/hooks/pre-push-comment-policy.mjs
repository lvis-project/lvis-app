import * as nodeModule from "node:module";

import { isCanonicalGitPath } from "./pre-push-markdown-policy.mjs";

export const MAX_COMMENT_ONLY_FILES = 64;
export const MAX_COMMENT_ONLY_BYTES = 4 * 1024 * 1024;

const safeSourcePath = /^src\/(?:[^/]+\/)*[^/]+\.(?:ts|js|mjs|cjs)$/;
const generatedPathSegment = /(?:^|\/)(?:__generated__|generated)(?:\/|$)/i;
const generatedBasename = /\.generated\.(?:ts|js|mjs|cjs)$/i;
const controlledComment = /^\/\/(?:[\/!#@]|\s*(?:@|#|eslint|prettier|biome|oxlint|tslint|deno|bun|node|vite|webpack|rollup|esbuild|istanbul|c8|v8|nyc|coverage|sourceurl|sourcemappingurl|spdx|copyright|license|codeql|lgtm|nosemgrep|nosonar|nolint|noinspection|snyk|sonar|fallthrough|falls-through|region|endregion|cspell|spellcheck|language)\b)/i;

export function isCommentOnlyLvisAppSourcePath(relativePath) {
  if (!isCanonicalGitPath(relativePath) || !safeSourcePath.test(relativePath)) return false;
  return !generatedPathSegment.test(relativePath) && !generatedBasename.test(relativePath);
}

function isSafeStandaloneCommentLine(line) {
  const indentation = line.match(/^[ \t]*/)?.[0].length ?? 0;
  const comment = line.slice(indentation);
  if (!comment.startsWith("//")) return false;
  if (comment.length > 2 && comment[2] !== " " && comment[2] !== "\t") return false;
  return !controlledComment.test(comment);
}

function withoutSafeStandaloneComments(source) {
  return source
    .split("\n")
    .filter((line) => !isSafeStandaloneCommentLine(line))
    .join("\n");
}

function parsedOutput(parser, source) {
  try {
    return parser(source, { mode: "transform", sourceMap: false });
  } catch {
    return null;
  }
}

export function isStandaloneCommentOnlyJavaScriptChange(
  before,
  after,
  parser = nodeModule.stripTypeScriptTypes
) {
  if (typeof before !== "string" || typeof after !== "string" || before === after) return false;
  if (before.includes("\0") || after.includes("\0")) return false;
  if (typeof parser !== "function") return false;

  const withoutBeforeComments = withoutSafeStandaloneComments(before);
  const withoutAfterComments = withoutSafeStandaloneComments(after);
  if (withoutBeforeComments !== withoutAfterComments) return false;
  if (withoutBeforeComments === before && withoutAfterComments === after) return false;

  const beforeOutput = parsedOutput(parser, before);
  const afterOutput = parsedOutput(parser, after);
  return beforeOutput !== null && beforeOutput === afterOutput;
}

export function selectCommentOnlyLvisAppFiles(
  changes,
  readBlob,
  parser = nodeModule.stripTypeScriptTypes
) {
  if (!Array.isArray(changes) || changes.length === 0 || typeof readBlob !== "function") {
    return { eligible: false, reason: "no changed files were resolved", files: [] };
  }
  if (typeof parser !== "function") {
    return { eligible: false, reason: "the Node TypeScript parser is unavailable", files: [] };
  }

  const files = new Set();
  let totalBytes = 0;
  for (const change of changes) {
    if (change?.status !== "M") {
      return {
        eligible: false,
        reason: `Git status ${change?.status || "unknown"} requires full checks`,
        files: [],
      };
    }
    if (!isCommentOnlyLvisAppSourcePath(change.path)) {
      return {
        eligible: false,
        reason: `${change.path || "unknown path"} is not a comment-fast-path source file`,
        files: [],
      };
    }
    if (typeof change.baseSha !== "string" || typeof change.localSha !== "string") {
      return { eligible: false, reason: "change object ids are unavailable", files: [] };
    }

    const before = readBlob(change.baseSha, change.path);
    const after = readBlob(change.localSha, change.path);
    if (typeof before !== "string" || typeof after !== "string") {
      return { eligible: false, reason: `could not read ${change.path}`, files: [] };
    }
    totalBytes += Buffer.byteLength(before) + Buffer.byteLength(after);
    if (totalBytes > MAX_COMMENT_ONLY_BYTES) {
      return { eligible: false, reason: "comment-only source exceeds the safe byte limit", files: [] };
    }
    if (!isStandaloneCommentOnlyJavaScriptChange(before, after, parser)) {
      return { eligible: false, reason: `${change.path} changes parsed source`, files: [] };
    }
    files.add(change.path);
  }

  const sortedFiles = [...files].sort();
  if (sortedFiles.length > MAX_COMMENT_ONLY_FILES) {
    return {
      eligible: false,
      reason: `more than ${MAX_COMMENT_ONLY_FILES} source files changed`,
      files: [],
    };
  }
  return {
    eligible: true,
    reason: `${sortedFiles.length} source file(s) changed only in standalone comments`,
    files: sortedFiles,
  };
}
