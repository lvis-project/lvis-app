#!/usr/bin/env node
// App-owned pre-commit / pre-push checks for lvis-app.
//
// Migrated out of the vendored dev-tools runner so lvis-app owns its own gate
// (build-time audit #8). Scope is lvis-app only: the dev-tools runner's
// multi-repo dispatch, canonical-file drift detection, and plugin-manifest
// validation (all for sibling repos) are intentionally not carried here.
//
// The one behavioural improvement over the dev-tools original is a self-healing
// Electron-ABI step (see ensureAppTestRuntimeAbi): a stray `npm rebuild` that
// rebuilt better-sqlite3 for the Node ABI used to kill every push with a
// confusing NODE_MODULE_VERSION mismatch under the Electron test runner. We now
// realign it the same way `postinstall` does, then re-probe.
//
// Stages: pre-commit | pre-push | manual. Bypass once with LVIS_HOOKS_SKIP=1.

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { withElectronNativeRebuildLock } from "../lib/electron-native-modules.mjs";
import { ensureElectronAbiBetterSqlite3 } from "./node-native-abi.mjs";
import { spawnSyncPortable as spawnSync } from "./spawn-command.mjs";
import {
  isCanonicalGitPath,
  isReviewOnlyDocumentationPath,
  isSensitiveMarkdownPath,
} from "./pre-push-markdown-policy.mjs";
import { selectCommentOnlyLvisAppFiles } from "./pre-push-comment-policy.mjs";
import { selectTargetedLvisAppVitestFiles } from "./pre-push-test-policy.mjs";

const isWindows = process.platform === "win32";

const commands = {
  bun: isWindows ? "bun.exe" : "bun",
  git: "git",
  node: isWindows ? "node.exe" : "node",
  npm: isWindows ? "npm.cmd" : "npm",
  npx: isWindows ? "npx.cmd" : "npx",
};

function parseArgs(argv) {
  const parsed = {
    stage: "manual",
    repo: process.cwd(),
    remote: null,
    remoteLocation: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--stage") {
      parsed.stage = argv[++i];
      continue;
    }
    if (arg === "--repo") {
      parsed.repo = argv[++i];
      continue;
    }
    if (arg === "--remote") {
      parsed.remote = argv[++i] ?? null;
      continue;
    }
    if (arg === "--remote-location") {
      parsed.remoteLocation = argv[++i] ?? null;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  parsed.repo = resolve(parsed.repo);
  return parsed;
}

function hasFile(path) {
  return existsSync(path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function hasPackageScript(dir, name) {
  const packageJsonPath = join(dir, "package.json");
  if (!hasFile(packageJsonPath)) return false;
  return Boolean(readJson(packageJsonPath).scripts?.[name]);
}

function isNamedPackage(dir, name) {
  const packageJsonPath = join(dir, "package.json");
  if (!hasFile(packageJsonPath)) return false;
  try {
    return readJson(packageJsonPath).name === name;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

function capture(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(stderr || `${cmd} ${args.join(" ")} failed`);
  }
  return (result.stdout || "").trim();
}

function captureOptional(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    return "";
  }
  return (result.stdout || "").trim();
}

function run(cmd, args, cwd) {
  console.log(`\n[checks] ${basename(cwd)} :: ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}`);
  }
}

function available(...candidates) {
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      stdio: "ignore",
      env: process.env,
    });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Electron test-runtime ABI (self-healing)
// ---------------------------------------------------------------------------

function requireElectronNodeVitest(dir) {
  const packageJsonPath = join(dir, "package.json");
  if (!hasFile(packageJsonPath)) {
    throw new Error("[electron-vitest-runner-required] lvis-app package.json is missing");
  }
  const parsed = readJson(packageJsonPath);
  if (
    parsed.scripts?.["test:vitest"] !==
    "node scripts/run-vitest-under-electron.mjs"
  ) {
    throw new Error(
      "[electron-vitest-runner-required] lvis-app must define the canonical test:vitest script"
    );
  }
}

function resolveElectronVersion(dir) {
  const packageJsonPath = join(dir, "node_modules", "electron", "package.json");
  if (!hasFile(packageJsonPath)) return null;
  try {
    return readJson(packageJsonPath).version || null;
  } catch {
    return null;
  }
}

function rebuildBetterSqlite3ForElectron(dir) {
  return withElectronNativeRebuildLock(dir, () => {
    // A launcher or another hook may have repaired the shared checkout while
    // this process waited. Avoid a second mutation of the same native tree.
    try {
      ensureElectronAbiBetterSqlite3(dir);
      return;
    } catch {
      // The caller already recorded the original probe failure. Continue with
      // the canonical hook repair and let its final probe surface any failure.
    }

    const version = resolveElectronVersion(dir);
    const rebuildArgs = [
      "electron-rebuild",
      "-f",
      "--only",
      "better-sqlite3",
      ...(version ? ["-v", version] : []),
    ];
    const bun = available(commands.bun);
    if (bun) {
      run(bun, ["x", ...rebuildArgs], dir);
      return;
    }
    const npx = available(commands.npx);
    if (npx) {
      run(npx, ["-y", ...rebuildArgs], dir);
      return;
    }
    throw new Error(
      "[electron-rebuild-unavailable] bun or npx is required to realign better-sqlite3 to the Electron ABI"
    );
  });
}

function ensureAppTestRuntimeAbi(dir) {
  requireElectronNodeVitest(dir);
  try {
    return ensureElectronAbiBetterSqlite3(dir);
  } catch (error) {
    // better-sqlite3 drifted off the Electron ABI (classically a stray
    // `npm rebuild` that rebuilt it for the Node ABI). Realign it the same way
    // `postinstall` does, then re-probe — one self-healing chokepoint so a push
    // never dies on a confusing NODE_MODULE_VERSION mismatch.
    console.log(`[checks] ${basename(dir)} :: ${error.message}`);
    console.log(
      `[checks] ${basename(dir)} :: realigning better-sqlite3 to the Electron test ABI…`
    );
    rebuildBetterSqlite3ForElectron(dir);
    return ensureElectronAbiBetterSqlite3(dir);
  }
}

// ---------------------------------------------------------------------------
// Push / commit branch policy
// ---------------------------------------------------------------------------

function getProtectedBranchNames(repoRoot) {
  const names = new Set(["main", "master"]);
  const remotes = captureOptional(commands.git, ["remote"], repoRoot)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const remote of remotes) {
    const remoteHead = captureOptional(
      commands.git,
      ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`],
      repoRoot
    );
    if (!remoteHead.startsWith(`${remote}/`)) continue;
    const branchName = remoteHead.slice(remote.length + 1);
    if (branchName) {
      names.add(branchName);
    }
  }

  return names;
}

function parsePrePushUpdates(input) {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const updates = [];
  let complete = lines.length > 0;

  for (const line of lines) {
    const fields = line.split(/\s+/);
    if (fields.length !== 4) {
      complete = false;
      continue;
    }
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    const validObjectIds = [localSha, remoteSha].every((sha) =>
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)
    );
    if (!localRef || !remoteRef || !validObjectIds) {
      complete = false;
      continue;
    }
    updates.push({ localRef, localSha, remoteRef, remoteSha });
  }

  return { updates, complete: complete && updates.length === lines.length };
}

function readPrePushInput() {
  if (process.stdin.isTTY) {
    return "";
  }
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function runPushPolicyChecks(repoRoot, parsedUpdates) {
  if (!parsedUpdates.complete) {
    throw new Error(
      "[PRE_PUSH_REF_PARSE] refusing push because ref updates could not be parsed completely."
    );
  }
  const { updates } = parsedUpdates;

  const protectedBranchNames = getProtectedBranchNames(repoRoot);
  const blocked = updates
    .filter((update) => update.remoteRef.startsWith("refs/heads/"))
    .map((update) => update.remoteRef.slice("refs/heads/".length))
    .filter((branchName) => protectedBranchNames.has(branchName));

  if (blocked.length === 0) return;

  const uniqueBlocked = [...new Set(blocked)].sort();
  throw new Error(
    [
      "[DEFAULT_BRANCH_DIRECT_PUSH] refusing direct push to protected branch.",
      `Blocked branch(es): ${uniqueBlocked.join(", ")}`,
      "Create a non-default branch and merge through a pull request.",
    ].join("\n")
  );
}

// On deploy hosts (operator-marked via env `LVIS_DEPLOY_HOST=1`), refuse
// `git commit` on a protected branch — a host-local commit on main can change
// the host's git state before any push. Dev hosts (no env) → no-op. Detached
// HEAD → no-op. Escape hatch: `git commit --no-verify` (auditable via reflog).
function runCommitPolicyChecks(repoRoot) {
  if (process.env.LVIS_DEPLOY_HOST !== "1") return;
  const currentBranch = captureOptional(
    commands.git,
    ["symbolic-ref", "--short", "HEAD"],
    repoRoot
  ).trim();
  if (!currentBranch) return;
  const protectedBranchNames = getProtectedBranchNames(repoRoot);
  if (!protectedBranchNames.has(currentBranch)) return;
  throw new Error(
    [
      "[DEPLOY_HOST_DIRECT_COMMIT] refusing direct commit on a protected branch on the deploy host.",
      `Blocked branch: ${currentBranch}`,
      "On deploy hosts (LVIS_DEPLOY_HOST=1), commit on a feature branch and push to origin, then merge via PR.",
      "Recovery escape hatch: `git commit --no-verify` (audit via `git reflog`).",
    ].join("\n")
  );
}

// ---------------------------------------------------------------------------
// Pre-push change classification (docs-only / comment-only / targeted tests)
// ---------------------------------------------------------------------------

function isNullObjectId(sha) {
  return /^0+$/.test(sha);
}

function getVerifiedRemoteDefault(repoRoot, remoteName, remoteLocation) {
  if (!remoteName || !/^[A-Za-z0-9._-]+$/.test(remoteName)) return null;
  if (
    typeof remoteLocation !== "string" ||
    remoteLocation.length === 0 ||
    /[\0\r\n]/.test(remoteLocation)
  ) {
    return null;
  }

  const result = spawnSync(
    commands.git,
    ["ls-remote", "--symref", "--", remoteLocation, "HEAD"],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    }
  );
  if (result.error || result.status !== 0) return null;

  let defaultBranchRef = null;
  let liveTip = null;
  const lines = (result.stdout || "").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 2 || fields[1] !== "HEAD") return null;
    if (fields[0].startsWith("ref: ")) {
      if (defaultBranchRef !== null) return null;
      defaultBranchRef = fields[0].slice("ref: ".length);
      continue;
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(fields[0]) || liveTip !== null) {
      return null;
    }
    liveTip = fields[0];
  }

  if (!defaultBranchRef?.startsWith("refs/heads/") || liveTip === null) return null;
  const branchName = defaultBranchRef.slice("refs/heads/".length);
  if (!branchName || branchName === "HEAD") return null;

  const trackingRef = `refs/remotes/${remoteName}/${branchName}`;
  const trackingTip = captureOptional(
    commands.git,
    ["show-ref", "--verify", "--hash", trackingRef],
    repoRoot
  );
  if (trackingTip.toLowerCase() !== liveTip.toLowerCase()) return null;
  return { trackingRef };
}

function findNewBranchBase(repoRoot, localSha, remoteName, remoteLocation) {
  const remoteDefault = getVerifiedRemoteDefault(repoRoot, remoteName, remoteLocation);
  if (!remoteDefault) return null;
  const base = captureOptional(
    commands.git,
    ["merge-base", localSha, remoteDefault.trackingRef],
    repoRoot
  );
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(base)) {
    return base;
  }
  return null;
}

function isFastForwardUpdate(repoRoot, remoteSha, localSha) {
  const result = spawnSync(
    commands.git,
    ["merge-base", "--is-ancestor", remoteSha, localSha],
    {
      cwd: repoRoot,
      stdio: "ignore",
    }
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) return null;
  return result.status === 0;
}

function decodeUtf8Strict(output) {
  if (!Buffer.isBuffer(output)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output);
  } catch {
    return null;
  }
}

function getChangedEntries(repoRoot, baseSha, localSha) {
  const result = spawnSync(
    commands.git,
    ["diff", "--no-renames", "--name-status", "-z", `${baseSha}..${localSha}`, "--"],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  if (result.error || result.status !== 0) return null;

  const decoded = decodeUtf8Strict(result.stdout);
  if (decoded === null) return null;
  const fields = decoded.split("\0");
  if (fields.at(-1) !== "") return null;
  fields.pop();

  const entries = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!/^[A-Z][0-9]*$/.test(status)) return null;
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    if (index + pathCount > fields.length) return null;
    for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
      entries.push({ status, path: fields[index++] });
    }
  }
  return entries;
}

function getGitBlob(repoRoot, objectId, relativePath) {
  const result = spawnSync(commands.git, ["show", `${objectId}:${relativePath}`], {
    cwd: repoRoot,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return null;
  return decodeUtf8Strict(result.stdout);
}

function classifyPrePushChanges(repoRoot, parsedUpdates, remoteName, remoteLocation) {
  if (!parsedUpdates.complete || parsedUpdates.updates.length === 0) {
    return { docsOnly: false, reason: "ref updates could not be classified" };
  }

  const changedFiles = new Set();
  const changedEntries = [];
  let targetedTestsEligible = true;
  let targetedTestsReason = "";
  let commentOnlyEligible = true;
  for (const update of parsedUpdates.updates) {
    if (isNullObjectId(update.localSha)) {
      return { docsOnly: false, reason: `deleted ref ${update.remoteRef} requires full checks` };
    }

    const isNewBranch = isNullObjectId(update.remoteSha);
    const baseSha = isNewBranch
      ? findNewBranchBase(repoRoot, update.localSha, remoteName, remoteLocation)
      : update.remoteSha;
    if (!baseSha) {
      return { docsOnly: false, reason: `no conservative base found for ${update.localRef}` };
    }

    if (
      !update.localRef.startsWith("refs/heads/") ||
      !update.remoteRef.startsWith("refs/heads/")
    ) {
      targetedTestsEligible = false;
      commentOnlyEligible = false;
      targetedTestsReason ||= "only branch updates can use targeted tests";
    } else if (isNewBranch) {
      commentOnlyEligible = false;
    } else if (isFastForwardUpdate(repoRoot, update.remoteSha, update.localSha) !== true) {
      targetedTestsEligible = false;
      commentOnlyEligible = false;
      targetedTestsReason ||= "non-fast-forward updates require full checks";
    }

    const entries = getChangedEntries(repoRoot, baseSha, update.localSha);
    if (entries === null) {
      return { docsOnly: false, reason: `git diff failed for ${update.localRef}` };
    }
    for (const entry of entries) {
      changedFiles.add(entry.path);
      changedEntries.push({ ...entry, baseSha, localSha: update.localSha });
    }
  }

  if (changedFiles.size === 0) {
    return { docsOnly: false, reason: "no changed files were resolved" };
  }
  const noncanonicalPath = [...changedFiles].find((file) => !isCanonicalGitPath(file));
  if (noncanonicalPath) {
    return { docsOnly: false, reason: "noncanonical Git path requires full checks" };
  }
  const sensitiveMarkdownPath = [...changedFiles].find(isSensitiveMarkdownPath);
  if (sensitiveMarkdownPath) {
    return {
      docsOnly: false,
      reason: `sensitive Markdown ${sensitiveMarkdownPath} requires full checks`,
    };
  }
  if ([...changedFiles].some((file) => !isReviewOnlyDocumentationPath(file))) {
    if (commentOnlyEligible) {
      const commentSelection = selectCommentOnlyLvisAppFiles(
        changedEntries,
        (objectId, relativePath) => getGitBlob(repoRoot, objectId, relativePath)
      );
      if (commentSelection.eligible) {
        return {
          docsOnly: false,
          commentOnly: true,
          commentFiles: commentSelection.files,
          reason: commentSelection.reason,
        };
      }
    }
    if (targetedTestsEligible) {
      const selection = selectTargetedLvisAppVitestFiles(changedEntries);
      if (selection.eligible) {
        return {
          docsOnly: false,
          testOnly: true,
          testFiles: selection.files,
          testSupportFiles: selection.supportFiles,
          supportTestFiles: selection.supportTestFiles,
          reason: selection.reason,
        };
      }
      targetedTestsReason ||= selection.reason;
    }
    return {
      docsOnly: false,
      testOnly: false,
      reason: targetedTestsReason || "non-review-only files changed",
    };
  }
  return { docsOnly: true, reason: `${changedFiles.size} Markdown file(s) changed` };
}

// ---------------------------------------------------------------------------
// Staged safety scan (merge markers, TLS-verification bypass)
// ---------------------------------------------------------------------------

function getStagedFiles(repoRoot) {
  const output = capture(
    commands.git,
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    repoRoot
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getStagedFileContent(repoRoot, relativePath) {
  const result = spawnSync(commands.git, ["show", `:${relativePath}`], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) {
    return "";
  }
  return result.stdout ?? "";
}

function runStagedSafetyChecks(repoRoot) {
  run(commands.git, ["diff", "--cached", "--check"], repoRoot);
  const files = getStagedFiles(repoRoot);
  const violations = [];
  const dangerousPatterns = [
    { label: "merge conflict markers", regex: /^(<<<<<<< |=======|>>>>>>> )/m },
    {
      label: "TLS verification bypass",
      regex:
        /(NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|rejectUnauthorized\s*:\s*false|strictSSL\s*:\s*false|verify\s*=\s*False|ssl\._create_unverified_context)/m,
    },
  ];

  for (const relativePath of files) {
    const stagedContent = getStagedFileContent(repoRoot, relativePath);
    if (!stagedContent || stagedContent.includes(String.fromCharCode(0))) continue;
    for (const pattern of dangerousPatterns) {
      if (pattern.regex.test(stagedContent)) {
        violations.push(`${relativePath}: ${pattern.label}`);
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(`staged safety checks failed:\n- ${violations.join("\n- ")}`);
  }
}

// ---------------------------------------------------------------------------
// Package checks
// ---------------------------------------------------------------------------

function getPackageManager(dir) {
  const bun = available(commands.bun);
  const npm = available(commands.npm);
  if (hasFile(join(dir, "bun.lock")) || hasFile(join(dir, "bun.lockb"))) {
    if (bun) return bun;
    if (npm) return npm;
    throw new Error(`bun or npm is required for ${dir}`);
  }
  if (hasFile(join(dir, "package-lock.json"))) {
    if (npm) return npm;
    if (bun) return bun;
    throw new Error(`npm or bun is required for ${dir}`);
  }
  if (bun) return bun;
  if (npm) return npm;
  throw new Error(`bun or npm is required for ${dir}`);
}

function getJsRuntime() {
  const runtime = available(commands.node, commands.bun);
  if (!runtime) {
    throw new Error("node or bun is required for JavaScript-based LVIS checks");
  }
  return runtime;
}

function runPackageScripts(dir, scriptNames) {
  if (!hasFile(join(dir, "package.json"))) return;
  const packageManager = getPackageManager(dir);
  for (const scriptName of scriptNames) {
    if (!hasPackageScript(dir, scriptName)) continue;
    run(packageManager, ["run", scriptName], dir);
  }
}

function runJavaScriptFile(dir, relativePath) {
  const filePath = join(dir, relativePath);
  if (!hasFile(filePath)) return;
  run(getJsRuntime(), [filePath], dir);
}

function runAppChecks(dir) {
  const bun = available(commands.bun);
  if (!bun) {
    throw new Error("bun is required for lvis-app checks");
  }
  if (hasFile(join(dir, "packages", "plugin-sdk", "package.json"))) {
    runPackageScripts(join(dir, "packages", "plugin-sdk"), ["check:drift", "build"]);
  }
  ensureAppTestRuntimeAbi(dir);
  runPackageScripts(dir, ["lint", "check:knip", "typecheck", "test", "build"]);
  runJavaScriptFile(dir, "scripts/check-tool-namespace.mjs");
}

function runAppTargetedVitestChecks(dir, testFiles, supportTestFiles = []) {
  const bun = available(commands.bun);
  if (!bun) {
    throw new Error("bun is required for targeted lvis-app Vitest checks");
  }
  if (!hasPackageScript(dir, "typecheck")) {
    throw new Error("lvis-app typecheck script is required for targeted Vitest checks");
  }
  if (!hasPackageScript(dir, "check:test-duplicates")) {
    throw new Error(
      "lvis-app targeted Vitest checks require the check:test-duplicates script"
    );
  }
  const targetTestFiles = [...new Set([...testFiles, ...supportTestFiles])].sort();
  if (targetTestFiles.length === 0) {
    throw new Error("targeted lvis-app Vitest checks resolved no test files");
  }
  for (const relativePath of targetTestFiles) {
    if (!hasFile(join(dir, relativePath))) {
      throw new Error(`targeted lvis-app Vitest file is missing: ${relativePath}`);
    }
  }

  runPackageScripts(dir, ["typecheck"]);
  run(bun, ["run", "check:test-duplicates", "--", "--fail-on-duplicates"], dir);
  ensureAppTestRuntimeAbi(dir);
  const vitestArgs = targetTestFiles.map((file) => `./${file}`);
  run(bun, ["run", "test:vitest", "--", "run", ...vitestArgs], dir);
}

function runAppCommentOnlyChecks(dir) {
  if (!hasPackageScript(dir, "typecheck")) {
    throw new Error("lvis-app typecheck script is required for comment-only checks");
  }
  runPackageScripts(dir, ["typecheck"]);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const { stage, repo, remote, remoteLocation } = parseArgs(process.argv.slice(2));
const repoRoot = resolve(repo);

if (!isNamedPackage(repoRoot, "lvis-app") && basename(repoRoot) !== "lvis-app") {
  // App-scoped runner: fail loudly if a mis-wired hook points it at another
  // repo, rather than silently skipping that repo's checks.
  throw new Error(
    `[app-checks-scope] run-local-checks is lvis-app only (repo=${basename(repoRoot)})`
  );
}

const prePushUpdates =
  stage === "pre-push" ? parsePrePushUpdates(readPrePushInput()) : null;

console.log(`[checks] stage=${stage} repo=${basename(repoRoot)}`);

if (stage === "pre-commit") {
  runCommitPolicyChecks(repoRoot);
  runStagedSafetyChecks(repoRoot);
} else if (stage === "pre-push" || stage === "manual") {
  if (stage === "pre-push") {
    runPushPolicyChecks(repoRoot, prePushUpdates);
  }
  runStagedSafetyChecks(repoRoot);
  const classification =
    stage === "pre-push"
      ? classifyPrePushChanges(repoRoot, prePushUpdates, remote, remoteLocation)
      : { docsOnly: false };
  if (classification.docsOnly) {
    console.log(
      `[checks] docs-only pre-push: skipping lint/typecheck/test/build (${classification.reason})`
    );
  } else if (classification.commentOnly) {
    console.log(
      `[checks] comment-only pre-push: running typecheck; skipping full test/build (${classification.reason})`
    );
    runAppCommentOnlyChecks(repoRoot);
  } else if (classification.testOnly) {
    const testCodeFileCount =
      classification.testFiles.length + classification.testSupportFiles.length;
    console.log(
      `[checks] test-only pre-push: running typecheck, duplicate-helper policy, and ` +
        `${testCodeFileCount} targeted Vitest code file(s); skipping full test/build ` +
        `(${classification.reason})`
    );
    runAppTargetedVitestChecks(
      repoRoot,
      classification.testFiles,
      classification.supportTestFiles
    );
  } else {
    runAppChecks(repoRoot);
  }
} else {
  throw new Error(`unsupported stage: ${stage}`);
}
