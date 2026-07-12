import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const LEGACY_DETECTOR_SHA256 =
  "c18916f06ee792b513ed85f0b90c586cf55ec8f9f0a8b8ba6450c21a205acb6a";

describe("trusted cluster policy transition", () => {
  it("keeps the legacy required-check workflow byte-identical", () => {
    const legacy = readFileSync(
      ".github/workflows/cluster-detector.yml",
      "utf8",
    ).replace(/\r\n/g, "\n");

    expect(createHash("sha256").update(legacy).digest("hex")).toBe(
      LEGACY_DETECTOR_SHA256,
    );
    expect(legacy).toContain("\n  pull_request:\n");
    expect(legacy).not.toContain("pull_request_target:");
  });

  it("keeps general invalidation while bridging only PR 1603", () => {
    const bridge = readFileSync(
      ".github/workflows/cluster-review-label-invalidator.yml",
      "utf8",
    );

    expect(bridge).toContain("pull_request_target:");
    expect(bridge).not.toContain("\n  pull_request:\n");
    expect(bridge).toContain("branches: [main]");
    expect(bridge).toContain(
      "types: [opened, reopened, synchronize, edited, labeled, unlabeled]",
    );
    expect(bridge).toContain("permissions: {}");
    expect(bridge).toContain("cancel-in-progress: false");
    expect(bridge).not.toContain("cancel-in-progress: true");

    const invalidateIndex = bridge.indexOf("  invalidate:");
    const transitionIndex = bridge.indexOf("  transition-policy:");
    expect(invalidateIndex).toBeGreaterThan(-1);
    expect(transitionIndex).toBeGreaterThan(invalidateIndex);

    const invalidate = bridge.slice(invalidateIndex, transitionIndex);
    expect(invalidate).toContain(
      "github.event.pull_request.number != 1603",
    );
    expect(invalidate).toContain("github.event.action == 'synchronize'");
    expect(invalidate).toContain("github.event.action == 'reopened'");
    expect(invalidate).toContain("github.event.action == 'edited'");
    expect(invalidate).toContain("contains(toJSON(github.event.changes)");
    expect(invalidate).toContain("issues: write");
    expect(invalidate).not.toContain("statuses: write");
    expect(invalidate).not.toContain("actions/checkout");
    expect(invalidate).not.toContain("scripts/");
    expect(invalidate).toContain(
      "issues/${PR_NUMBER}/labels/cluster-review-passed",
    );

    const transition = bridge.slice(transitionIndex);
    const finalizerIndex = transition.indexOf(
      "      - name: Finalize cluster policy status",
    );
    expect(finalizerIndex).toBeGreaterThan(-1);
    const finalizer = transition.slice(finalizerIndex);

    expect(transition).toContain("github.event.pull_request.number == 1603");
    expect(transition).toContain(
      "github.event.pull_request.base.ref == 'main'",
    );
    expect(transition).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(transition).toContain(
      "github.event.pull_request.head.ref == 'agent/gpt56-instruction-cleanup'",
    );
    expect(transition).toContain("contents: read");
    expect(transition).toContain("pull-requests: read");
    expect(transition).toContain("statuses: write");
    expect(transition).toContain("issues: write");
    expect(transition).toContain("STATUS_CONTEXT: Sensitive Area Cluster Check");
    expect(transition).toContain("state=pending");
    expect(transition).toContain("github.event.pull_request.head.sha");
    expect(transition).toContain(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7",
    );
    expect(transition).not.toContain("actions/checkout@v7");
    expect(transition).toContain(
      "ref: ${{ steps.pr-snapshot.outputs.base_sha }}",
    );
    expect(transition).not.toContain(
      "ref: ${{ github.event.pull_request.head.sha }}",
    );
    expect(transition).toContain("persist-credentials: false");
    expect(transition).toContain("git -C .cluster-policy rev-parse HEAD");
    expect(transition).toContain("scripts/check-cluster-scope.mjs");
    expect(transition).toContain(
      `jq -er '.sensitive | if type == "boolean" then tostring else error("invalid .sensitive") end'`,
    );
    expect(transition).toContain(
      `jq -er '.violation | if type == "boolean" then tostring else error("invalid .violation") end'`,
    );
    expect(transition).toContain(
      `jq -er '.reason | if type == "string" then . else error("invalid .reason") end'`,
    );
    expect(transition).not.toContain("jq -er '.sensitive'");
    expect(transition).not.toContain("jq -er '.violation'");
    expect(transition).toContain(
      "scripts/check-cluster-review-attestation.mjs",
    );
    expect(transition).toContain(
      "name: Enforce transition cluster review attestation",
    );
    expect(transition).toContain(
      "if: steps.cluster-attestation.outputs.attested != 'true'",
    );
    expect(transition).not.toContain(
      "steps.cluster-check.outputs.violation == 'true' &&",
    );
    expect(transition).toContain("FINAL_DIGEST");
    expect(transition).toContain('if [ "$FINAL_DIGEST" != "$EXPECTED_DIGEST" ]');
    expect(transition).toContain("name: Finalize cluster policy status");
    expect(transition).toContain("if: always()");
    expect(transition).toContain("STATUS_STATE=failure");
    expect(transition).toContain('elif [ "$ATTESTED" = "true" ]; then');
    expect(transition).toContain(
      "Current-head cluster review attestation is required for transition",
    );
    expect(transition).toContain("FINALIZER_FAILED=1");
    expect(transition).toContain('elif [ "$PRIOR_JOB_STATUS" != "success" ]');

    expect(finalizer).not.toContain("$VIOLATION");
    expect(finalizer.match(/^\s*STATUS_STATE=success$/gm) ?? []).toHaveLength(1);

    const digestIndex = finalizer.indexOf(
      'elif [ "$FINAL_DIGEST" != "$EXPECTED_DIGEST" ]; then',
    );
    const attestedIndex = finalizer.indexOf(
      'elif [ "$ATTESTED" = "true" ]; then',
    );
    const revalidateIndex = finalizer.indexOf(
      "check-cluster-review-attestation.mjs",
      attestedIndex,
    );
    const grepIndex = finalizer.indexOf(
      'grep -Fxq "attested=true"',
      revalidateIndex,
    );
    const successIndex = finalizer.indexOf(
      "STATUS_STATE=success",
      grepIndex,
    );
    const missingAttestationIndex = finalizer.indexOf(
      "Current-head cluster review attestation is required for transition",
      successIndex,
    );
    const statusPostIndex = finalizer.indexOf(
      'gh api --method POST "repos/${REPO}/statuses/${HEAD_SHA}"',
      missingAttestationIndex,
    );

    expect(attestedIndex).toBeGreaterThan(digestIndex);
    expect(revalidateIndex).toBeGreaterThan(attestedIndex);
    expect(grepIndex).toBeGreaterThan(revalidateIndex);
    expect(successIndex).toBeGreaterThan(grepIndex);
    expect(missingAttestationIndex).toBeGreaterThan(successIndex);
    expect(statusPostIndex).toBeGreaterThan(missingAttestationIndex);
    expect(
      finalizer.slice(missingAttestationIndex, statusPostIndex),
    ).not.toContain("STATUS_STATE=success");
  });

  it("limits the temporary status-write surface to two audited workflows", () => {
    const workflowDir = ".github/workflows";
    const owners = readdirSync(workflowDir)
      .filter((file) => /\.ya?ml$/.test(file))
      .filter((file) =>
        readFileSync(`${workflowDir}/${file}`, "utf8").includes(
          "statuses: write",
        ),
      )
      .sort();

    expect(owners).toEqual([
      "cluster-detector.yml",
      "cluster-review-label-invalidator.yml",
    ]);
  });
});
