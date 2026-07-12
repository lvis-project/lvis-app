import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateClusterReviewAttestation } from "../../scripts/check-cluster-review-attestation.mjs";

const HEAD = "a".repeat(40);
const STALE_HEAD = "b".repeat(40);

function validBody(sha = HEAD) {
  return `## Cross-Cutting Review Gate
Reviewed HEAD: \`${sha}\`
<!-- cluster-review:architect:${sha}:GO -->
<!-- cluster-review:critic:${sha}:GO -->
<!-- cluster-review:security:${sha}:GO -->`;
}

function pullRequest({ body = validBody(), labels = [{ name: "cluster-review-passed" }], sha = HEAD } = {}) {
  return { body, head: { sha }, labels };
}

describe("cluster review attestation", () => {
  it("accepts exactly one GO marker per role for the labeled current HEAD", () => {
    expect(evaluateClusterReviewAttestation(pullRequest())).toEqual({ attested: true, reason: "attested" });
  });

  it("accepts the completed repository template for the current HEAD", () => {
    const body = readFileSync(".github/pull_request_template.md", "utf8")
      .replaceAll("<40-char-head-sha>", HEAD);
    expect(evaluateClusterReviewAttestation(pullRequest({ body }))).toEqual({
      attested: true,
      reason: "attested",
    });
  });

  it("rejects marker substrings with noncanonical prefix or suffix text", () => {
    const marker = `<!-- cluster-review:architect:${HEAD}:GO -->`;
    const body = validBody().replace(marker, `prefix${marker}suffix`);
    expect(evaluateClusterReviewAttestation(pullRequest({ body })).reason).toBe(
      "invalid-marker",
    );
  });

  it("rejects leftover template placeholders beside valid markers", () => {
    const body = `${validBody()}
<!-- cluster-review:architect:<40-char-head-sha>:GO -->`;
    expect(evaluateClusterReviewAttestation(pullRequest({ body })).reason).toBe(
      "invalid-marker",
    );
  });

  it("rejects a missing exemption label", () => {
    expect(evaluateClusterReviewAttestation(pullRequest({ labels: [] })).reason).toBe("missing-label");
  });

  it("rejects a missing role marker", () => {
    const body = validBody().replace(`<!-- cluster-review:security:${HEAD}:GO -->`, "");
    expect(evaluateClusterReviewAttestation(pullRequest({ body })).reason).toBe("missing-role:security");
  });

  it("rejects duplicate role markers", () => {
    const marker = `<!-- cluster-review:critic:${HEAD}:GO -->`;
    expect(evaluateClusterReviewAttestation(pullRequest({ body: `${validBody()}\n${marker}` })).reason).toBe("duplicate-role:critic");
  });

  it("rejects stale markers after synchronize changes the current HEAD", () => {
    const body = validBody(STALE_HEAD).replace(`Reviewed HEAD: \`${STALE_HEAD}\``, `Reviewed HEAD: \`${HEAD}\``);
    expect(evaluateClusterReviewAttestation(pullRequest({ body })).reason).toBe("stale-head:architect");
  });

  it("invalidates a retained label after synchronize changes the current HEAD", () => {
    expect(
      evaluateClusterReviewAttestation(pullRequest({ body: validBody(STALE_HEAD) })),
    ).toEqual({ attested: false, reason: "stale-reviewed-head" });
  });

  it("rejects a NO-GO verdict", () => {
    const body = validBody().replace(`<!-- cluster-review:architect:${HEAD}:GO -->`, `<!-- cluster-review:architect:${HEAD}:NO-GO -->`);
    expect(evaluateClusterReviewAttestation(pullRequest({ body })).reason).toBe("no-go:architect");
  });
});
