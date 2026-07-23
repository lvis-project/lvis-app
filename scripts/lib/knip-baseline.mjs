import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const KNIP_BASELINE_SCHEMA_VERSION = 1;

export const NON_BASELINE_ISSUE_TYPES = new Set([
  "binaries",
  "unlisted",
  "unresolved",
]);

function issueName(item) {
  if (Array.isArray(item)) {
    const names = item.map((entry) => entry?.name);
    if (names.some((name) => typeof name !== "string" || name.length === 0)) {
      throw new Error("Knip duplicate issue contains an invalid name");
    }
    return names.sort().join(",");
  }
  if (!item || typeof item !== "object" || typeof item.name !== "string") {
    throw new Error("Knip issue contains an invalid name");
  }
  return item.name;
}

export function normalizeKnipIssues(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.issues)) {
    throw new Error("Knip JSON report is missing its issues array");
  }

  const normalized = [];
  for (const row of report.issues) {
    if (!row || typeof row !== "object" || typeof row.file !== "string") {
      throw new Error("Knip JSON report contains an invalid issue row");
    }
    for (const [type, items] of Object.entries(row)) {
      if (type === "file" || !Array.isArray(items)) continue;
      for (const item of items) {
        normalized.push({
          type,
          file: row.file,
          name: issueName(item),
        });
      }
    }
  }

  return normalized.sort((left, right) =>
    issueKey(left).localeCompare(issueKey(right), "en"));
}

function issueKey(issue) {
  return `${issue.type}\u0000${issue.file}\u0000${issue.name}`;
}

export function compareKnipBaseline(current, baseline) {
  const currentByKey = new Map(current.map((issue) => [issueKey(issue), issue]));
  const baselineByKey = new Map(baseline.map((issue) => [issueKey(issue), issue]));

  return {
    added: current.filter((issue) => !baselineByKey.has(issueKey(issue))),
    resolved: baseline.filter((issue) => !currentByKey.has(issueKey(issue))),
  };
}

export function countKnipIssuesByType(issues) {
  const counts = new Map();
  for (const issue of issues) counts.set(issue.type, (counts.get(issue.type) ?? 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right, "en"));
}

export function formatKnipIssue(issue) {
  return `${issue.type} ${issue.file} ${issue.name}`;
}

const DEFAULT_ATOMIC_WRITE_RUNTIME = {
  platform: process.platform,
  open: openSync,
  write: (fd, content) => writeFileSync(fd, content, { encoding: "utf8" }),
  flush: fsyncSync,
  close: closeSync,
  replace: renameSync,
  remove: (path) => rmSync(path, { force: true }),
  wait: (milliseconds) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  },
};

function replaceStagedBaseline(from, to, runtime) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      runtime.replace(from, to);
      return;
    } catch (error) {
      const retryable = runtime.platform === "win32"
        && ["EPERM", "EACCES", "EBUSY"].includes(error?.code)
        && attempt < 3;
      if (!retryable) throw error;
      runtime.wait(10 * (attempt + 1));
    }
  }
}

/**
 * Replace the reviewed baseline without exposing a truncated target. The
 * staging file is unique, resides on the target filesystem, and is flushed
 * before rename. Failed updates leave the prior baseline intact and remove the
 * uncommitted staging file.
 */
export function writeKnipBaselineAtomicSync(
  filePath,
  content,
  runtime = DEFAULT_ATOMIC_WRITE_RUNTIME,
) {
  const tempPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd;
  let committed = false;
  let operationError;
  try {
    fd = runtime.open(tempPath, "wx", 0o644);
    runtime.write(fd, content);
    runtime.flush(fd);
    runtime.close(fd);
    fd = undefined;
    replaceStagedBaseline(tempPath, filePath, runtime);
    committed = true;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (fd !== undefined) {
      try {
        runtime.close(fd);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!committed) {
      try {
        runtime.remove(tempPath);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, ...cleanupErrors],
          "Knip baseline update and staging cleanup both failed",
        );
      }
      throw cleanupErrors[0];
    }
  }
}
