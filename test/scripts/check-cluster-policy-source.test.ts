import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("trusted cluster policy workflow", () => {
  it("evaluates trusted-base sensitive clusters as an advisory", () => {
    const workflow = readFileSync(
      ".github/workflows/cluster-detector.yml",
      "utf8",
    );

    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).not.toContain("\n  pull_request:\n");
    expect(workflow).toContain("types: [opened, reopened, synchronize, edited]");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).not.toContain("issues:");
    expect(workflow).not.toContain("statuses:");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).not.toContain("cancel-in-progress: false");
    expect(workflow).toContain("name: Trusted Cluster Policy Evaluation");

    expect(workflow).toContain(
      `jq -er '.sensitive | if type == "boolean" then tostring else error("invalid .sensitive") end'`,
    );
    expect(workflow).toContain(
      `jq -er '.violation | if type == "boolean" then tostring else error("invalid .violation") end'`,
    );
    expect(workflow).toContain(
      `jq -er '.reason | if type == "string" then . else error("invalid .reason") end'`,
    );
    expect(workflow).not.toContain("jq -er '.sensitive'");
    expect(workflow).not.toContain("jq -er '.violation'");

    const snapshotIndex = workflow.indexOf("Capture live pull request snapshot");
    const checkoutIndex = workflow.indexOf("Checkout trusted cluster policy");
    const verifyIndex = workflow.indexOf("Verify trusted cluster policy checkout");
    const checkIndex = workflow.indexOf(
      "Check sensitive area changes and cluster window",
    );
    const advisoryIndex = workflow.indexOf("Publish cluster advisory");
    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(checkoutIndex).toBeGreaterThan(snapshotIndex);
    expect(verifyIndex).toBeGreaterThan(checkoutIndex);
    expect(checkIndex).toBeGreaterThan(verifyIndex);
    expect(advisoryIndex).toBeGreaterThan(checkIndex);

    expect(workflow).toContain("github.event.pull_request.head.sha");
    expect(workflow).toContain(
      `jq -er '.base.ref | if type == "string" and . != "" then . else error("invalid .base.ref") end'`,
    );
    expect(workflow).toContain(
      `jq -er '.base.repo.full_name | if type == "string" and . != "" then . else error("invalid .base.repo.full_name") end'`,
    );
    expect(workflow).toContain(
      'if [ "$LIVE_BASE_REF" != "main" ] || [ "$LIVE_BASE_REPO" != "$REPO" ]; then',
    );
    expect(workflow).toContain('if [ "$LIVE_HEAD_SHA" != "$EVENT_HEAD_SHA" ]');
    expect(workflow).toContain('echo "superseded=true" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain(
      "if: steps.pr-snapshot.outputs.superseded != 'true'",
    );
    expect(workflow).toContain(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7",
    );
    expect(workflow).not.toContain("actions/checkout@v7");
    expect(workflow).toContain("path: .cluster-policy");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain(
      "ref: ${{ steps.pr-snapshot.outputs.base_sha }}",
    );
    expect(workflow).toContain("git -C .cluster-policy rev-parse HEAD");
    expect(workflow).toContain(
      'if [ "$CHECKED_OUT_SHA" != "$EXPECTED_BASE_SHA" ]',
    );
    expect(workflow).toContain(".cluster-policy/scripts/check-cluster-scope.mjs");
    expect(workflow).not.toContain("node scripts/");
    expect(workflow).not.toContain(
      "ref: ${{ github.event.pull_request.head.sha }}",
    );
    expect(workflow).not.toContain(
      "ref: ${{ github.event.pull_request.base.sha }}",
    );
    expect(workflow).not.toContain("gh pr checkout");
    expect(workflow).not.toContain("git fetch");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("|| true");
    expect(workflow).not.toContain("continue-on-error");

    for (const forbidden of [
      "cluster-review-passed",
      "check-cluster-review-attestation",
      "Sensitive Area Cluster Check",
      "STATUS_CONTEXT",
      "/statuses/",
      "labels/",
      "Enforce cluster review gate",
      "if: always()",
    ]) {
      expect(workflow).not.toContain(forbidden);
    }

    const advisory = workflow.slice(advisoryIndex);
    expect(advisory).toContain('if [ "$VIOLATION" = "true" ]');
    expect(advisory).toContain("::warning::Sensitive-area cluster advisory");
    expect(advisory).toContain("GITHUB_STEP_SUMMARY");
    expect(advisory).toContain("never requires a label, attestation, collaborator");
    expect(advisory).not.toContain("exit 1");

    expect(
      existsSync("scripts/check-cluster-review-attestation.mjs"),
    ).toBe(false);
    expect(
      existsSync("test/scripts/check-cluster-review-attestation.test.ts"),
    ).toBe(false);
    expect(
      existsSync(".github/workflows/cluster-review-label-invalidator.yml"),
    ).toBe(false);
  });
});
