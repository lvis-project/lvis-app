import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STATUS_CONTEXT = "Sensitive Area Cluster Check";

describe("trusted cluster policy workflow", () => {
  it("owns status, invalidation, and trusted-base evaluation in one run", () => {
    const workflow = readFileSync(
      ".github/workflows/cluster-detector.yml",
      "utf8",
    );

    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).not.toContain("\n  pull_request:\n");
    expect(workflow).toContain(
      "types: [opened, reopened, synchronize, edited, labeled, unlabeled]",
    );
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).toContain("statuses: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toContain("cancel-in-progress: true");
    expect(workflow).toContain("name: Trusted Cluster Policy Evaluation");
    expect(workflow).not.toContain("    name: Sensitive Area Cluster Check");

    const stepsIndex = workflow.indexOf("    steps:");
    const pendingIndex = workflow.indexOf("      - name: Publish pending cluster status");
    const invalidationIndex = workflow.indexOf(
      "      - name: Invalidate retained cluster review label",
    );
    const snapshotIndex = workflow.indexOf("      - name: Capture live pull request snapshot");
    const checkoutIndex = workflow.indexOf("      - name: Checkout trusted cluster policy");
    const verifyIndex = workflow.indexOf("      - name: Verify trusted cluster policy checkout");
    const finalizerIndex = workflow.indexOf("      - name: Finalize cluster policy status");
    expect(pendingIndex).toBe(workflow.indexOf("      - name:", stepsIndex));
    expect(invalidationIndex).toBeGreaterThan(pendingIndex);
    expect(snapshotIndex).toBeGreaterThan(invalidationIndex);
    expect(checkoutIndex).toBeGreaterThan(snapshotIndex);
    expect(verifyIndex).toBeGreaterThan(checkoutIndex);
    expect(finalizerIndex).toBeGreaterThan(verifyIndex);
    expect(workflow.match(/- name: Finalize cluster policy status/g)).toHaveLength(1);
    expect(workflow).not.toContain("Revalidate live pull request snapshot");
    expect(workflow).not.toContain("Publish final cluster status");

    expect(
      workflow.match(new RegExp("STATUS_CONTEXT: " + STATUS_CONTEXT, "g")),
    ).toHaveLength(2);
    expect(workflow).toContain("-f state=pending");
    expect(workflow).toContain('repos/${REPO}/statuses/${HEAD_SHA}');
    expect(workflow).toContain(
      "issues/${PR_NUMBER}/labels/cluster-review-passed",
    );
    expect(workflow).toContain("github.event.action == 'edited'");
    expect(workflow).toContain("github.event.action == 'synchronize'");
    expect(workflow).toContain("github.event.action == 'reopened'");
    expect(workflow).not.toContain("github.event.changes");

    expect(workflow).toContain("github.event.pull_request.head.sha");
    expect(workflow).toContain('if ! [[ "$HEAD_SHA" =~ ^[0-9a-fA-F]{40}$ ]]');
    expect(workflow).toContain('if [ "$LIVE_HEAD_SHA" != "$EVENT_HEAD_SHA" ]');
    expect(workflow).toContain('echo "head_sha=${LIVE_HEAD_SHA}"');
    expect(workflow).toContain('echo "base_sha=${LIVE_BASE_SHA}"');
    expect(workflow).toContain(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7",
    );
    expect(workflow).not.toContain("actions/checkout@v7");
    expect(workflow).toContain(
      "ref: ${{ steps.pr-snapshot.outputs.base_sha }}",
    );
    expect(workflow).toContain("git -C .cluster-policy rev-parse HEAD");
    expect(workflow).toContain(
      'if [ "$CHECKED_OUT_SHA" != "$EXPECTED_BASE_SHA" ]',
    );
    expect(workflow).toContain("persist-credentials: false");

    const finalizer = workflow.slice(finalizerIndex);
    const finalSnapshotFetchIndex = finalizer.indexOf(
      'gh api "repos/${REPO}/pulls/${PR_NUMBER}"',
    );
    const finalDigestIndex = finalizer.indexOf("FINAL_DIGEST=");
    const finalAttestationIndex = finalizer.indexOf(
      "node .cluster-policy/scripts/check-cluster-review-attestation.mjs",
    );
    const finalPostIndex = finalizer.indexOf(
      'gh api --method POST "repos/${REPO}/statuses/${HEAD_SHA}"',
    );
    expect(finalSnapshotFetchIndex).toBeGreaterThan(-1);
    expect(finalDigestIndex).toBeGreaterThan(finalSnapshotFetchIndex);
    expect(finalAttestationIndex).toBeGreaterThan(finalDigestIndex);
    expect(finalPostIndex).toBeGreaterThan(finalAttestationIndex);
    expect(finalizer).toContain("if: always()");
    expect(finalizer).toContain("PRIOR_JOB_STATUS: ${{ job.status }}");
    expect(finalizer).toContain('elif [ "$PRIOR_JOB_STATUS" != "success" ]');
    expect(finalizer).toContain(
      'elif [ "$FINAL_DIGEST" != "$EXPECTED_DIGEST" ]',
    );
    expect(finalizer).toContain(
      'elif [ "$VIOLATION" = "true" ] && [ "$ATTESTED" = "true" ]',
    );
    expect(finalizer).toContain("STATUS_STATE=failure");
    expect(finalizer).toContain("STATUS_STATE=success");
    expect(finalizer).toContain(
      'if ! gh api --method POST "repos/${REPO}/statuses/${HEAD_SHA}"',
    );
    expect(finalizer).toContain('if [ "$FINALIZER_FAILED" -ne 0 ]');
    expect(finalizer).toContain("exit 1");

    expect(workflow).toContain(
      ".cluster-policy/scripts/check-cluster-scope.mjs",
    );
    expect(workflow).toContain(
      ".cluster-policy/scripts/check-cluster-review-attestation.mjs",
    );
    expect(workflow).not.toContain("node scripts/");
    expect(workflow).not.toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(workflow).not.toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(workflow).not.toContain("|| true");
    expect(
      existsSync(".github/workflows/cluster-review-label-invalidator.yml"),
    ).toBe(false);
  });
});
