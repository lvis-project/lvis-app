import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { hasSensitiveClusterPath } from "./check-cluster-sensitive-paths.mjs";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_FILES = 3000;
const DEFAULT_MAX_COMMITS = 250;
const DEFAULT_MAX_PULL_PAGES = 1000;
const DEFAULT_MAX_WINDOW_PASSES = 4;
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
// edit to a sensitive file is documentation, not a security decision, so it
// produces only an advisory. Every record is still validated (via
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

  for (let page = 1; page <= maxPullPages; page += 1) {
    // Recomputed per page: the stop condition is "this page reached past the
    // window", which is a property of the page's OLDEST entry — not of its
    // last entry, which is only the oldest when the ordering held.
    let oldestUpdatedInPage = Number.POSITIVE_INFINITY;
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
      const updatedAt = timestamp(pull.updated_at, "pull-request-updated-at-invalid");
      // Deliberately NOT asserted to be descending. `updated_at` is a MUTABLE
      // sort key: a pull touched while this scan is paginating moves toward
      // page one, and an item can then appear on a later page carrying a newer
      // timestamp than the previous page's tail. Observed on a real
      // repository — one break, exactly at a page boundary, and that
      // particular shift produced no repeat, so the `seen` set below did not
      // register it either.
      //
      // Asserting an order the API does not guarantee under concurrent
      // mutation turned an ordinary merge landing mid-scan into a hard CI
      // failure, and it bought no completeness. A pull whose `updated_at`
      // rises ABOVE the prefix this pass has already read is never delivered
      // to this pass, order assertion or not. That hole is covered by the
      // repeated scan in `evaluateSensitiveRollingWindow` — within its pass
      // budget, and only once the pull has stopped moving — not here.
      if (updatedAt < oldestUpdatedInPage) oldestUpdatedInPage = updatedAt;

      // Same mutable-sort-key cause as the note above, seen from the other
      // side. When a pull's `updated_at` rises mid-scan it moves toward page
      // one, which pushes a neighbour DOWN across the page boundary — so an
      // entry already read arrives a second time. That is the API behaving as
      // documented under concurrent mutation, not corruption, and a repeat
      // carries no information the first sighting did not.
      //
      // It is skipped rather than counted, because counting it twice would
      // inflate the cluster window and fail the gate for the wrong reason.
      // The skip happens AFTER `oldestUpdatedInPage`: the stop condition is a
      // property of the page that arrived, and a page whose entries were all
      // repeats would otherwise contribute nothing and never terminate.
      if (seen.has(number)) continue;
      seen.add(number);

      if (pull.merged_at === null) continue;
      const mergedAt = timestamp(pull.merged_at, "pull-request-merged-at-invalid");
      // Only the number is carried out. `updated_at` and `merged_at` decide
      // membership and nothing downstream, and keeping them made two passes
      // over the same members compare unequal whenever one of them advanced.
      if (mergedAt >= sinceTime) candidates.push(number);
    }

    // Stop once a page has reached past the window. What makes that sound is
    // `updated_at >= merged_at` — an update is at least as recent as the merge
    // that caused it — so on a list sorted by `updated_at` descending, a page
    // whose OLDEST `updated_at` predates the window is followed only by pulls
    // that also merged before it.
    //
    // Keyed on the page's minimum rather than its last entry. Those coincide
    // while the ordering holds, and the minimum is `<=` the last entry always,
    // so this stop fires whenever a last-entry stop would and sometimes a page
    // sooner: it reads a SUBSET of the pages a last-entry stop reads, never a
    // superset. That makes it the cheaper scan, NOT the more complete one. When
    // the order breaks WITHIN a page it can end the scan with an in-window pull
    // unread on the next page, and no later pass recovers it — a rescan
    // re-requests the same pages and re-derives the same truncated list. The
    // suite's `stops on the page's OLDEST entry` fixture is that exact shape:
    // it holds an in-window sensitive pull on page two that no scan fetches.
    //
    // Left as it is rather than widened here: this key is long-standing
    // behaviour, and reading further costs requests on every run of the gate.
    //
    // A pull whose sort key MOVES is a different hole from the one above, and
    // the one the repeated scan in `evaluateSensitiveRollingWindow` does cover:
    // it travels toward page one and can cross a boundary this scan already
    // passed, and a later pass, once it settles, delivers it.
    if (pulls.length < pageSize || oldestUpdatedInPage < sinceTime) return candidates;
  }

  fail("pull-request-pages-saturated");
}

// The window is read more than once on purpose, and the passes are UNIONED
// rather than compared for equality.
//
// Reading it once is not enough. `updated_at` is a mutable sort key, so a pull
// touched mid-scan moves toward page one; one that crosses above the prefix a
// pass has already consumed is never delivered to that pass. A later pass, run
// once the move has settled, does deliver it.
//
// Comparing the passes for equality was the previous shape and it was wrong in
// both directions. It fired on differences that mean nothing — a candidate's
// `updated_at` advancing, the same members arriving in another order — so one
// unrelated merge landing during the evaluation failed the run. And on the one
// difference that does mean something, an in-window pull the first pass missed,
// it produced a red check instead of counting the pull.
//
// The union is safe to take because the verdict is monotone: `sensitive` counts
// distinct pull numbers and only ever rises, so absorbing a late arrival can
// turn `hit` from false to true but never the reverse. That is also why a
// candidate seen by one pass and absent from the next is not an error — its
// verdict is already recorded, and losing the later sighting cannot lower the
// count.
//
// Bounded, because "every pass reveals another merge" would otherwise never
// settle on a busy repository. A settled window costs two scans — one to read
// it, one to confirm nothing new arrived — and the bound caps the worst case at
// four. Exhausting the bound does not mean no count exists; it means the window
// never stopped moving, so the count in hand may be an UNDERCOUNT. Refusing to
// report a possible undercount is the conservative choice, and it fails loudly
// rather than passing a number it cannot stand behind.
export function evaluateSensitiveRollingWindow({
  repo,
  since,
  threshold,
  requestPage,
  pageSize = DEFAULT_PAGE_SIZE,
  maxFiles = DEFAULT_MAX_FILES,
  maxPullPages = DEFAULT_MAX_PULL_PAGES,
  maxWindowPasses = DEFAULT_MAX_WINDOW_PASSES,
}) {
  const sinceTime = timestamp(since, "window-since-invalid");
  positiveInteger(threshold, "cluster-threshold-invalid");
  positiveInteger(maxPullPages, "window-page-limit-invalid");
  // Two scans is the floor, not one. This bounds SETTLING, and settling is
  // observable only by comparing a scan against the one after it: a run that
  // does not exit early on the threshold must make a second scan before it can
  // conclude the window is quiet.
  //
  // A plain positive-integer check accepted `1` and then did not hold it. On a
  // settled window it spent the second scan anyway and RETURNED a verdict — the
  // budget overspent rather than refused; only a window that kept moving
  // failed. (A run that reaches the threshold during the first scan does return
  // within one scan, but by the `sensitive >= threshold` exit in the loop
  // below, taken before settling is ever in question.) So `1` never meant one
  // scan: the parameter carried its stated meaning only from two upward.
  //
  // Rejected as invalid input instead, so it means what it says at every value
  // it accepts. Not reachable from `evaluateClusterScope` or the CLI.
  if (!Number.isInteger(maxWindowPasses) || maxWindowPasses < 2) {
    fail("window-pass-limit-invalid");
  }

  const collect = () =>
    collectRollingWindowCandidates({
      repo,
      sinceTime,
      requestPage,
      pageSize,
      maxPullPages,
    });

  const evaluated = new Set();
  let sensitive = 0;
  let pending = collect();

  // `pass` numbers the scan the bottom of the loop is about to make; the one
  // above already happened, which is why it starts at two.
  for (let pass = 2; ; pass += 1) {
    for (const number of pending) {
      evaluated.add(number);

      const detail = pullDetail(repo, number, requestPage);
      if (
        pullRequestTouchesSensitiveFiles({
          repo,
          number,
          expectedFileCount: detail.changed_files,
          requestPage,
          pageSize,
          maxFiles,
        })
      ) {
        sensitive += 1;
        // No further pass can undo this: the count only rises.
        if (sensitive >= threshold) return { count: sensitive, hit: true };
      }
    }

    // Only what no pass has evaluated yet, and the whole of the cross-scan
    // deduplication — `collect` already returns each pull once per scan, so a
    // pull delivered by several passes is fetched and counted exactly once.
    // Deliberately the ONLY guard: a second one inside the loop above would be
    // unreachable, and two overlapping guards each hide the other's removal.
    pending = collect().filter((number) => !evaluated.has(number));
    if (pending.length === 0) return { count: sensitive, hit: false };
    if (pass >= maxWindowPasses) fail("pull-request-window-unsettled");
  }
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
