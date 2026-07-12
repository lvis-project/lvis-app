import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REVIEW_LABEL = "cluster-review-passed";
const REVIEW_ROLES = ["architect", "critic", "security"];
const HEAD_PATTERN = "[0-9a-fA-F]{40}";

function rejected(reason) {
  return { attested: false, reason };
}

export function evaluateClusterReviewAttestation(pullRequest) {
  if (!pullRequest || typeof pullRequest !== "object") return rejected("invalid-pull-request");

  const labels = Array.isArray(pullRequest.labels) ? pullRequest.labels : [];
  const hasLabel = labels.some((label) =>
    typeof label === "string" ? label === REVIEW_LABEL : label?.name === REVIEW_LABEL,
  );
  if (!hasLabel) return rejected("missing-label");

  const headSha = pullRequest.head?.sha;
  if (typeof headSha !== "string" || !new RegExp(`^${HEAD_PATTERN}$`).test(headSha)) {
    return rejected("invalid-head-sha");
  }

  const body = typeof pullRequest.body === "string" ? pullRequest.body.replaceAll("\r", "") : "";
  if (!/^## Cross-Cutting Review Gate$/m.test(body)) return rejected("missing-section");

  const reviewedHeads = [
    ...body.matchAll(new RegExp(`^Reviewed HEAD: \\\`${HEAD_PATTERN}\\\`$`, "gm")),
  ];
  if (reviewedHeads.length === 0) return rejected("missing-reviewed-head");
  if (reviewedHeads.length > 1) return rejected("duplicate-reviewed-head");
  const reviewedHead = reviewedHeads[0][0].slice("Reviewed HEAD: `".length, -1);
  if (reviewedHead.toLowerCase() !== headSha.toLowerCase()) return rejected("stale-reviewed-head");

  const markerPattern = new RegExp(
    `^<!-- cluster-review:(architect|critic|security):(${HEAD_PATTERN}):(GO|NO-GO) -->$`,
  );
  const markerLines = body.split("\n").filter((line) => line.includes("cluster-review:"));
  const markers = [];
  for (const line of markerLines) {
    const match = line.match(markerPattern);
    if (!match) return rejected("invalid-marker");
    markers.push({ role: match[1], sha: match[2], verdict: match[3] });
  }

  for (const role of REVIEW_ROLES) {
    const roleMarkers = markers.filter((marker) => marker.role === role);
    if (roleMarkers.length === 0) return rejected(`missing-role:${role}`);
    if (roleMarkers.length > 1) return rejected(`duplicate-role:${role}`);
    const [marker] = roleMarkers;
    if (marker.verdict !== "GO") return rejected(`no-go:${role}`);
    if (marker.sha.toLowerCase() !== headSha.toLowerCase()) return rejected(`stale-head:${role}`);
  }

  return { attested: true, reason: "attested" };
}

function runFromActionsEnvironment() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!eventPath || !outputPath) throw new Error("GITHUB_EVENT_PATH and GITHUB_OUTPUT are required");

  let result;
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    result = evaluateClusterReviewAttestation(event.pull_request);
  } catch {
    result = rejected("invalid-event");
  }

  appendFileSync(outputPath, `attested=${result.attested}\nreason=${result.reason}\n`, "utf8");
  console.log(`Cluster review attestation: ${result.reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromActionsEnvironment();
}
