const sensitiveMarkdownBasenames = new Set([
  "agents.md",
  "claude.md",
  "contributing.md",
  "security.md",
]);

const sensitiveMarkdownFiles = new Set([
  ".github/pull_request_template.md",
  "docs/development/release-process.md",
]);

const sensitiveMarkdownPrefixes = [
  ".github/pull_request_template/",
  ".github/workflows/",
  "resources/",
  "docs/architecture/",
  "docs/blueprints/",
  "docs/security/",
  "docs/ko/architecture/",
];

const reviewOnlyMarkdownFiles = new Set([
  "readme.md",
  "changelog.md",
  "code_of_conduct.md",
  "todo.md",
]);

const reviewOnlyMarkdownPrefixes = [
  ".github/issue_template/",
  "docs/guides/",
  "docs/ko/guides/",
  "docs/research/",
];

export function isCanonicalGitPath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) return false;
  if (relativePath.includes("\\") || relativePath.startsWith("/")) return false;
  if (/^[a-z]:\//i.test(relativePath) || /[\u0000-\u001f\u007f-\u009f]/.test(relativePath)) return false;
  return relativePath.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".."
  );
}

export function isSensitiveMarkdownPath(relativePath) {
  if (!isCanonicalGitPath(relativePath)) return false;
  const normalized = relativePath.toLowerCase();
  if (!normalized.endsWith(".md")) return false;
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return sensitiveMarkdownBasenames.has(basename) ||
    sensitiveMarkdownFiles.has(normalized) ||
    sensitiveMarkdownPrefixes.some((prefix) => normalized.startsWith(prefix));
}

export function isReviewOnlyDocumentationPath(relativePath) {
  if (!isCanonicalGitPath(relativePath) || isSensitiveMarkdownPath(relativePath)) return false;
  const normalized = relativePath.toLowerCase();
  if (!normalized.endsWith(".md")) return false;
  return reviewOnlyMarkdownFiles.has(normalized) ||
    reviewOnlyMarkdownPrefixes.some((prefix) => normalized.startsWith(prefix));
}
