import { isCanonicalGitPath } from "./pre-push-markdown-policy.mjs";

export const MAX_TARGETED_VITEST_FILES = 64;
export const MAX_TARGETED_VITEST_ARGUMENT_CHARS = 16_384;

const deniedPathSegments = new Set([
  "__fixtures__",
  "__snapshots__",
  "e2e",
  "fixtures",
  "playwright",
  "screenshots",
]);

const generatedAssetTestBasenames = new Set([
  "app-icon-assets.test.ts",
  "desktop-packaging.test.ts",
  "tray-icon.test.ts",
]);

const safeCliPath = /^[A-Za-z0-9._+@/-]+$/;
const collectedVitestPath = /^(?:src\/(?:[^/]+\/)*__tests__\/(?:[^/]+\/)*|test\/(?:[^/]+\/)*)(?:[^/]+)\.(?:test|spec)\.(?:ts|tsx)$/;
const targetedVitestSupportConsumers = new Map([
  [
    "src/__tests__/test-helpers.ts",
    Object.freeze([
      "src/__tests__/ipc-bridge-permissions.test.ts",
      "src/__tests__/ipc-bridge-runtime-handlers.test.ts",
      "src/__tests__/window-manager-ipc.test.ts",
      "src/api/__tests__/a2a-subagent-handler.test.ts",
      "src/engine/__tests__/a2a-agent-message-bus.test.ts",
      "src/ipc/__tests__/mcp-app-download.test.ts",
      "src/ipc/__tests__/mcp-app-model-context.test.ts",
      "src/ipc/__tests__/usage.test.ts",
      "src/ipc/domains/__tests__/chat-import.test.ts",
      "src/ipc/domains/__tests__/chat-verbatim.test.ts",
      "src/ipc/domains/__tests__/chat-write-diff.test.ts",
      "src/ipc/domains/__tests__/diagnostics.test.ts",
      "src/main/__tests__/a2a-loopback-runtime.test.ts",
      "src/main/__tests__/ask-user-question-gate.test.ts",
      "src/main/__tests__/notification-integration.test.ts",
      "src/mcp/__tests__/mcp-stdio-sandbox-wrap.test.ts",
      "src/permissions/__tests__/worker-spawn.test.ts",
      "src/plugins/__tests__/configschema-architect-followups.test.ts",
      "src/plugins/runtime/__tests__/lifecycle.test.ts",
      "src/plugins/runtime/__tests__/session-activation-isolation.test.ts",
      "src/plugins/runtime/__tests__/set-enabled.test.ts",
      "src/plugins/runtime/__tests__/tool-visibility-invariant.test.ts",
      "src/tools/__tests__/agent-spawn-background.test.ts",
      "src/tools/__tests__/executor.test.ts",
    ]),
  ],
  [
    "src/api/__tests__/a2a-test-helpers.ts",
    Object.freeze([
      "src/api/__tests__/a2a-router.test.ts",
      "src/api/__tests__/a2a-subagent-handler.test.ts",
      "src/main/__tests__/a2a-loopback-runtime.test.ts",
    ]),
  ],
  [
    "scripts/smoke-windows-nsis-installer.mjs",
    Object.freeze(["test/scripts/smoke-windows-nsis-installer.test.ts"]),
  ],
]);

function isSafeTestTreePath(relativePath) {
  if (!isCanonicalGitPath(relativePath) || !safeCliPath.test(relativePath)) return false;
  const segments = relativePath.toLowerCase().split("/");
  return !segments.some((segment) => deniedPathSegments.has(segment));
}

export function isTargetableLvisAppVitestPath(relativePath) {
  if (!isSafeTestTreePath(relativePath)) return false;
  if (!collectedVitestPath.test(relativePath)) return false;

  const segments = relativePath.toLowerCase().split("/");
  return !generatedAssetTestBasenames.has(segments.at(-1));
}

export function isTargetableLvisAppVitestSupportPath(relativePath) {
  return (
    isSafeTestTreePath(relativePath) &&
    targetedVitestSupportConsumers.has(relativePath)
  );
}

export function selectTargetedLvisAppVitestFiles(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return {
      eligible: false,
      reason: "no changed files were resolved",
      files: [],
      supportFiles: [],
      supportTestFiles: [],
    };
  }

  const files = new Set();
  const supportFiles = new Set();
  for (const change of changes) {
    if (change?.status !== "A" && change?.status !== "M") {
      return {
        eligible: false,
        reason: `Git status ${change?.status || "unknown"} requires full checks`,
        files: [],
        supportFiles: [],
        supportTestFiles: [],
      };
    }
    if (isTargetableLvisAppVitestPath(change.path)) {
      files.add(change.path);
      continue;
    }
    if (isTargetableLvisAppVitestSupportPath(change.path)) {
      supportFiles.add(change.path);
      continue;
    }
    return {
      eligible: false,
      reason: `${change.path || "unknown path"} is not targetable Vitest code`,
      files: [],
      supportFiles: [],
      supportTestFiles: [],
    };
  }

  const sortedFiles = [...files].sort();
  const sortedSupportFiles = [...supportFiles].sort();
  const sortedSupportTestFiles = [
    ...new Set(
      sortedSupportFiles.flatMap(
        (file) => targetedVitestSupportConsumers.get(file) ?? []
      )
    ),
  ].sort();
  const allFiles = [
    ...new Set([
      ...sortedFiles,
      ...sortedSupportFiles,
      ...sortedSupportTestFiles,
    ]),
  ].sort();
  if (allFiles.length > MAX_TARGETED_VITEST_FILES) {
    return {
      eligible: false,
      reason: `more than ${MAX_TARGETED_VITEST_FILES} Vitest code files changed`,
      files: [],
      supportFiles: [],
      supportTestFiles: [],
    };
  }

  const argumentChars = allFiles.reduce((total, file) => total + file.length + 3, 0);
  if (argumentChars > MAX_TARGETED_VITEST_ARGUMENT_CHARS) {
    return {
      eligible: false,
      reason: "targeted Vitest arguments exceed the safe command limit",
      files: [],
      supportFiles: [],
      supportTestFiles: [],
    };
  }

  return {
    eligible: true,
    reason:
      `${sortedFiles.length} Vitest file(s) and ` +
      `${sortedSupportFiles.length} support file(s) changed`,
    files: sortedFiles,
    supportFiles: sortedSupportFiles,
    supportTestFiles: sortedSupportTestFiles,
  };
}
