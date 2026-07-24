import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  applyElectronVitestResult,
  runVitestUnderElectron,
} from "./run-vitest-under-electron.mjs";

export const DEFAULT_SHARD_COUNT = 4;
export const DEFAULT_MAX_WORKERS = 1;

export function createVitestRuns(
  args,
  shardCount = DEFAULT_SHARD_COUNT,
  maxWorkers = DEFAULT_MAX_WORKERS,
) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("[test-args-invalid] Test arguments must be strings");
  }
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error("[test-shard-count-invalid] Shard count must be a positive integer");
  }
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1) {
    throw new Error("[test-max-workers-invalid] Max workers must be a positive integer");
  }

  if (args.length > 0) {
    return [["run", ...args]];
  }

  return Array.from({ length: shardCount }, (_, index) => [
    "run",
    `--shard=${index + 1}/${shardCount}`,
    `--maxWorkers=${maxWorkers}`,
    "--no-file-parallelism",
  ]);
}

export async function runTests(
  args,
  {
    shardCount = DEFAULT_SHARD_COUNT,
    maxWorkers = DEFAULT_MAX_WORKERS,
    runVitest = runVitestUnderElectron,
    log = console.log,
  } = {},
) {
  const runs = createVitestRuns(args, shardCount, maxWorkers);
  let firstFailure = null;

  for (const [index, runArgs] of runs.entries()) {
    if (runs.length > 1) {
      log(`[test-suite] shard ${index + 1}/${runs.length}`);
    }
    const result = await runVitest(runArgs);
    if (result.signal) {
      return result;
    }
    if (result.code !== 0 && firstFailure === null) {
      firstFailure = result;
    }
  }

  return firstFailure ?? { code: 0, signal: null };
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const result = await runTests(process.argv.slice(2));
    applyElectronVitestResult(result);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
