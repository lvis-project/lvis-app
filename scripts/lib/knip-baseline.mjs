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
