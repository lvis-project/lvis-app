import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("trusted cluster policy workflow", () => {
  it("queues idempotent invalidations and never executes pull-request content", () => {
    const workflow = readFileSync(
      ".github/workflows/cluster-review-label-invalidator.yml",
      "utf8",
    );

    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("types: [synchronize, edited, reopened]");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toContain("cancel-in-progress: true");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("contains(toJSON(github.event.changes)");
    expect(workflow).toContain(
      "issues/${PR_NUMBER}/labels/cluster-review-passed",
    );
    expect(workflow).not.toContain("actions/checkout");
    expect(workflow).not.toContain("scripts/");
    expect(workflow).not.toContain("pull_request.head");
    expect(workflow).not.toContain("pull_request.body");
  });
});
