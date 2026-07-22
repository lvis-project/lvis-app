import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { hasSensitiveClusterPath } from "./check-cluster-sensitive-paths.mjs";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_FILES = 3000;
const DEFAULT_MAX_COMMITS = 250;
const DEFAULT_MAX_PULL_PAGES = 1000;
const SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FILE_STATUSES = new Set([
  "added",
  "changed",
  "copied",
  "modified",
  "removed",
  "renamed",
  "unchanged",
]);
const ORIGIN_FILE_STATUSES = new Set(["copied", "renamed"]);

function fail(code) {
  throw new Error(code);
}

function positiveInteger(value, code) {
  if (!Number.isInteger(value) || value <= 0) fail(code);
  return value;
}

function nonnegativeInteger(value, code) {
  if (!Number.isInteger(value) || value < 0) fail(code);
  return value;
}

function timestamp(value, code) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) fail(code);
  return parsed;
}

function arrayPage(value, pageSize, code) {
  if (!Array.isArray(value) || value.length > pageSize) fail(code);
  return value;
}

export function pathsFromFileRecords(records) {
  const paths = [];
  for (const record of records) {
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.filename !== "string" ||
      record.filename.length === 0 ||
      typeof record.status !== "string" ||
      !FILE_STATUSES.has(record.status)
    ) {
      fail("github-file-record-invalid");
    }

    const hasPrevious =
      typeof record.previous_filename === "string" &&
      record.previous_filename.length > 0;
    if (ORIGIN_FILE_STATUSES.has(record.status) && !hasPrevious) {
      fail("github-previous-filename-required");
    }
    if (
      record.previous_filename !== undefined &&
      record.previous_filename !== null &&
      !hasPrevious
    ) {
      fail("github-previous-filename-invalid");
    }

    paths.push(record.filename);
    if (hasPrevious) paths.push(record.previous_filename);
  }
  return paths;
}

// Conservative "the changed lines are only comments / blank" test for a unified
// diff patch. Returns true ONLY when every added/removed content line is clearly
// a comment or blank. A missing/unparseable patch, or ANY non-comment changed
// line, returns false so the file stays material — a real code change can never
// be misread as comment-only. Worst case a comment edit is treated as code and
// still reviewed (a safe false-positive), never the reverse.
export function isCommentOnlyPatch(patch) {
  if (typeof patch !== "string" || patch.length === 0) return false;
  let sawChange = false;
  for (const rawLine of patch.split("\n")) {
    if (
      rawLine.startsWith("+++") ||
      rawLine.startsWith("---") ||
      rawLine.startsWith("@@") ||
      rawLine.startsWith("\\") // "\ No newline at end of file"
    ) {
      continue;
    }
    if (!rawLine.startsWith("+") && !rawLine.startsWith("-")) continue; // context
    const body = rawLine.slice(1).trim();
    sawChange = true;
    if (body === "") continue; // blank line change
    if (
      body.startsWith("//") ||
      body.startsWith("/*") ||
      body.startsWith("*") || // "* jsdoc" continuation, "*/"
      body.startsWith("#") // yaml/shell/python comments in sensitive configs
    ) {
      continue;
    }
    return false; // a non-comment, non-blank changed line → material
  }
  return sawChange;
}

// Paths from records that carry a real (non-comment-only) change. A comment-only
// edit to a sensitive file is documentation, not a security decision, so it no
// longer forces cross-cutting review. Every record is still validated (via
// pathsFromFileRecords) before it can be excluded.
function materialPathsFromFileRecords(records) {
  const paths = [];
  for (const record of records) {
    const recordPaths = pathsFromFileRecords([record]);
    if (isCommentOnlyPatch(record?.patch)) continue;
    paths.push(...recordPaths);
  }
  return paths;
}

export function pullRequestTouchesSensitiveFiles({
  repo,
  number,
  expectedFileCount,
  requestPage,
  pageSize = DEFAULT_PAGE_SIZE,
  maxFiles = DEFAULT_MAX_FILES,
}) {
  positiveInteger(number, "pull-request-number-invalid");
  nonnegativeInteger(expectedFileCount, "pull-request-file-count-invalid");

  let total = 0;
  for (let page = 1; ; page += 1) {
    const records = arrayPage(
      requestPage("repos/" + repo + "/pulls/" + number + "/files", {
        page,
        per_page: pageSize,
      }),
      pageSize,
      "pull-request-files-invalid",
    );
    total += records.length;
    if (total > expectedFileCount) fail("pull-request-files-overflow");
    if (hasSensitiveClusterPath(materialPathsFromFileRecords(records))) return true;
    if (total === expectedFileCount) return false;
    if (records.length < pageSize) fail("pull-request-files-incomplete");
    if (total >= maxFiles) fail("pull-request-files-saturated");
  }
}

function commitTouchesSensitiveFiles({
  repo,
  sha,
  requestPage,
  pageSize,
  maxFiles,
}) {
  if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) fail("commit-sha-invalid");

  let total = 0;
  for (let page = 1; ; page += 1) {
    const response = requestPage("repos/" + repo + "/commits/" + sha, {
      page,
      per_page: pageSize,
    });
    if (!response || typeof response !== "object") fail("commit-response-invalid");
    const records = arrayPage(response.files, pageSize, "commit-files-invalid");
    total += records.length;
    if (hasSensitiveClusterPath(materialPathsFromFileRecords(records))) return true;
    if (records.length < pageSize) return false;
    if (total >= maxFiles) fail("commit-files-saturated");
  }
}

export function pullRequestHasSensitiveCommitBundle({
  repo,
  number,
  expectedCommitCount,
  threshold,
  requestPage,
  pageSize = DEFAULT_PAGE_SIZE,
  maxFiles = DEFAULT_MAX_FILES,
  maxCommits = DEFAULT_MAX_COMMITS,
}) {
  positiveInteger(number, "pull-request-number-invalid");
  positiveInteger(expectedCommitCount, "pull-request-commit-count-invalid");
  positiveInteger(threshold, "cluster-threshold-invalid");

  let total = 0;
  let sensitive = 0;
  for (let page = 1; ; page += 1) {
    const commits = arrayPage(
      requestPage("repos/" + repo + "/pulls/" + number + "/commits", {
        page,
        per_page: pageSize,
      }),
      pageSize,
      "pull-request-commits-invalid",
    );

    for (const commit of commits) {
      total += 1;
      if (total > expectedCommitCount) fail("pull-request-commits-overflow");
      if (
        commitTouchesSensitiveFiles({
          repo,
          sha: commit?.sha,
          requestPage,
          pageSize,
          maxFiles,
        })
      ) {
        sensitive += 1;
        if (sensitive >= threshold) return true;
      }
    }

    if (total === expectedCommitCount) return false;
    if (commits.length < pageSize) fail("pull-request-commits-incomplete");
    if (total >= maxCommits) fail("pull-request-commits-saturated");
  }
}

function pullDetail(repo, number, requestPage) {
  const detail = requestPage("repos/" + repo + "/pulls/" + number, {});
  if (!detail || typeof detail !== "object") fail("pull-request-detail-invalid");
  nonnegativeInteger(detail.changed_files, "pull-request-file-count-invalid");
  return detail;
}

function collectRollingWindowCandidates({
  repo,
  sinceTime,
  requestPage,
  pageSize,
  maxPullPages,
}) {
  const candidates = [];
  const seen = new Set();
  let previousUpdated = Number.POSITIVE_INFINITY;

  for (let page = 1; page <= maxPullPages; page += 1) {
    const pulls = arrayPage(
      requestPage("repos/" + repo + "/pulls", {
        direction: "desc",
        page,
        per_page: pageSize,
        sort: "updated",
        state: "closed",
      }),
      pageSize,
      "pull-request-page-invalid",
    );

    if (pulls.length === 0) return candidates;

    for (const pull of pulls) {
      if (!pull || typeof pull !== "object") fail("pull-request-record-invalid");
      const number = positiveInteger(pull.number, "pull-request-number-invalid");
      if (seen.has(number)) fail("pull-request-page-duplicate");
      seen.add(number);

      const updatedAt = timestamp(pull.updated_at, "pull-request-updated-at-invalid");
      if (updatedAt > previousUpdated) fail("pull-request-order-invalid");
      previousUpdated = updatedAt;

      if (pull.merged_at === null) continue;
      const mergedAt = timestamp(pull.merged_at, "pull-request-merged-at-invalid");
      if (mergedAt >= sinceTime) {
        candidates.push({
          merged_at: pull.merged_at,
          number,
          updated_at: pull.updated_at,
        });
      }
    }

    const lastUpdated = timestamp(
      pulls.at(-1).updated_at,
      "pull-request-updated-at-invalid",
    );
    if (pulls.length < pageSize || lastUpdated < sinceTime) return candidates;
  }

  fail("pull-request-pages-saturated");
}

export function evaluateSensitiveRollingWindow({
  repo,
  since,
  threshold,
  requestPage,
  pageSize = DEFAULT_PAGE_SIZE,
  maxFiles = DEFAULT_MAX_FILES,
  maxPullPages = DEFAULT_MAX_PULL_PAGES,
}) {
  const sinceTime = timestamp(since, "window-since-invalid");
  positiveInteger(threshold, "cluster-threshold-invalid");
  positiveInteger(maxPullPages, "window-page-limit-invalid");

  const candidates = collectRollingWindowCandidates({
    repo,
    sinceTime,
    requestPage,
    pageSize,
    maxPullPages,
  });

  let sensitive = 0;
  for (const pull of candidates) {
    const detail = pullDetail(repo, pull.number, requestPage);
    if (
      pullRequestTouchesSensitiveFiles({
        repo,
        number: pull.number,
        expectedFileCount: detail.changed_files,
        requestPage,
        pageSize,
        maxFiles,
      })
    ) {
      sensitive += 1;
      if (sensitive >= threshold) return { count: sensitive, hit: true };
    }
  }

  const revalidatedCandidates = collectRollingWindowCandidates({
    repo,
    sinceTime,
    requestPage,
    pageSize,
    maxPullPages,
  });
  if (JSON.stringify(revalidatedCandidates) !== JSON.stringify(candidates)) {
    fail("pull-request-window-changed");
  }

  return { count: sensitive, hit: false };
}

export function evaluateClusterScope({
  snapshot,
  repo,
  since,
  threshold,
  requestPage,
}) {
  if (!snapshot || typeof snapshot !== "object") fail("pull-request-snapshot-invalid");
  if (typeof repo !== "string" || !REPOSITORY_PATTERN.test(repo)) {
    fail("repository-name-invalid");
  }

  const number = positiveInteger(snapshot.number, "pull-request-number-invalid");
  const changedFiles = nonnegativeInteger(
    snapshot.changed_files,
    "pull-request-file-count-invalid",
  );
  const commitCount = positiveInteger(
    snapshot.commits,
    "pull-request-commit-count-invalid",
  );
  positiveInteger(threshold, "cluster-threshold-invalid");

  const sensitive = pullRequestTouchesSensitiveFiles({
    repo,
    number,
    expectedFileCount: changedFiles,
    requestPage,
  });
  if (!sensitive) {
    return {
      bundle: false,
      reason: "",
      sensitive: false,
      violation: false,
      window: false,
      windowCount: 0,
    };
  }

  const bundle = pullRequestHasSensitiveCommitBundle({
    repo,
    number,
    expectedCommitCount: commitCount,
    threshold,
    requestPage,
  });
  if (bundle) {
    return {
      bundle: true,
      reason: "bundle",
      sensitive: true,
      violation: true,
      window: false,
      windowCount: 0,
    };
  }

  const window = evaluateSensitiveRollingWindow({
    repo,
    since,
    threshold,
    requestPage,
  });
  return {
    bundle: false,
    reason: window.hit ? "window" : "",
    sensitive: true,
    violation: window.hit,
    window: window.hit,
    windowCount: window.count,
  };
}

export function createGhApiRequester(spawn = spawnSync) {
  return (endpoint, parameters) => {
    const args = ["api", "--method", "GET", endpoint];
    for (const [name, value] of Object.entries(parameters)) {
      args.push("-f", name + "=" + value);
    }
    const result = spawn("gh", args, {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status !== 0) fail("github-api-request-failed");
    try {
      return JSON.parse(result.stdout);
    } catch {
      fail("github-api-response-invalid");
    }
  };
}

function cliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail("cli-arguments-invalid");
    values[name.slice(2)] = value;
  }
  return values;
}

function runFromCli() {
  const args = cliArguments(process.argv.slice(2));
  if (!args.snapshot || !args.repo || !args.since || !args.threshold) {
    fail("cli-arguments-invalid");
  }

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(args.snapshot, "utf8"));
  } catch {
    fail("pull-request-snapshot-invalid");
  }

  const threshold = Number(args.threshold);
  const result = evaluateClusterScope({
    snapshot,
    repo: args.repo,
    since: args.since,
    threshold,
    requestPage: createGhApiRequester(),
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runFromCli();
  } catch (error) {
    const message =
      error instanceof Error && /^[a-z0-9-]+$/.test(error.message)
        ? error.message
        : "cluster-scope-invalid-input";
    console.error("cluster-scope-error:" + message);
    process.exitCode = 1;
  }
}
