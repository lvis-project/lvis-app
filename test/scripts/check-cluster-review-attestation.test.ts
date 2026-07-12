import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateClusterReviewAttestation } from "../../scripts/check-cluster-review-attestation.mjs";

const HEAD = "a".repeat(40);
const STALE_HEAD = "b".repeat(40);
const UPDATED_AT = "2026-07-12T00:00:00Z";

function tableRow(role: "Architect" | "Critic" | "Security", sha = HEAD) {
  return `| ${role} | \`${sha}\` | \`GO\` | None |`;
}

function validBody(sha = HEAD) {
  return `## Cross-Cutting Review Gate
Reviewed HEAD: \`${sha}\`

| Role | Reviewed HEAD SHA | Verdict | Blocking findings |
|---|---|---|---|
${tableRow("Architect", sha)}
${tableRow("Critic", sha)}
${tableRow("Security", sha)}

<!-- cluster-review:architect:${sha}:GO -->
<!-- cluster-review:critic:${sha}:GO -->
<!-- cluster-review:security:${sha}:GO -->`;
}

function pullRequest({
  body = validBody(),
  labels = [{ name: "cluster-review-passed" }],
  sha = HEAD,
  state = "open",
  updatedAt = UPDATED_AT,
} = {}) {
  return { body, head: { sha }, labels, state, updated_at: updatedAt };
}

function triggerEvent({
  action = "labeled",
  body = validBody(),
  changes,
  labelName = "cluster-review-passed",
  sha = HEAD,
  state = "open",
  updatedAt = UPDATED_AT,
} = {}) {
  return {
    action,
    changes,
    label: { name: labelName },
    pull_request: pullRequest({ body, sha, state, updatedAt }),
  };
}

describe("cluster review attestation", () => {
  it("accepts one consistent GO row and marker per role for the labeled current HEAD", () => {
    expect(evaluateClusterReviewAttestation(pullRequest())).toEqual({
      attested: true,
      reason: "attested",
    });
  });

  it("accepts the fully completed repository template for the current HEAD", () => {
    const body = readFileSync(".github/pull_request_template.md", "utf8")
      .replaceAll("<40-char-head-sha>", HEAD)
      .replaceAll("<HEAD_SHA>", HEAD)
      .replaceAll("`GO` / `NO-GO`", "`GO`")
      .replaceAll("None, or links/details", "None");
    expect(evaluateClusterReviewAttestation(pullRequest({ body }))).toEqual({
      attested: true,
      reason: "attested",
    });
  });

  it("binds workflow evaluation to the event HEAD and body", () => {
    expect(
      evaluateClusterReviewAttestation(pullRequest(), triggerEvent()),
    ).toEqual({ attested: true, reason: "attested" });
    expect(
      evaluateClusterReviewAttestation(
        pullRequest(),
        triggerEvent({ sha: STALE_HEAD, body: validBody(STALE_HEAD) }),
      ).reason,
    ).toBe("stale-event-head");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest(),
        triggerEvent({ body: `${validBody()}\nchanged` }),
      ).reason,
    ).toBe("stale-event-body");
  });

  it("invalidates retained labels for new commits, reopen, and body or base edits", () => {
    for (const event of [
      triggerEvent({ action: "synchronize" }),
      triggerEvent({ action: "reopened" }),
      triggerEvent({ action: "edited", changes: { body: { from: "old" } } }),
      triggerEvent({ action: "edited", changes: { base: { ref: { from: "old" } } } }),
    ]) {
      expect(evaluateClusterReviewAttestation(pullRequest(), event).reason).toMatch(
        "retained-label-invalidated:",
      );
    }
  });

  it("requires a fresh target review-label event after any other metadata event", () => {
    for (const event of [
      triggerEvent({ action: "edited", changes: { title: { from: "old" } } }),
      triggerEvent({ action: "labeled", labelName: "unrelated-label" }),
      triggerEvent({ action: "unlabeled" }),
    ]) {
      expect(evaluateClusterReviewAttestation(pullRequest(), event).reason).toBe(
        "fresh-review-label-required",
      );
    }
  });

  it("rejects stale event update generations and state", () => {
    expect(
      evaluateClusterReviewAttestation(
        pullRequest(),
        triggerEvent({ updatedAt: "2026-07-11T00:00:00Z" }),
      ).reason,
    ).toBe("stale-event-updated-at");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest(),
        triggerEvent({ state: "closed" }),
      ).reason,
    ).toBe("stale-event-state");
  });
  it("rejects duplicate gate sections", () => {
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({ body: `${validBody()}\n\n${validBody()}` }),
      ).reason,
    ).toBe("duplicate-section");
  });

  it("rejects any leftover template placeholder", () => {
    for (const placeholder of [
      "<40-char-head-sha>",
      "<HEAD_SHA>",
      "`GO` / `NO-GO`",
      "None, or links/details",
    ]) {
      expect(
        evaluateClusterReviewAttestation(
          pullRequest({ body: `${validBody()}\n${placeholder}` }),
        ).reason,
      ).toBe("template-placeholder");
    }
  });

  it("rejects marker substrings with noncanonical prefix or suffix text", () => {
    const marker = `<!-- cluster-review:architect:${HEAD}:GO -->`;
    const body = validBody().replace(marker, `prefix${marker}suffix`);
    expect(evaluateClusterReviewAttestation(pullRequest({ body })).reason).toBe(
      "invalid-marker",
    );
  });

  it("rejects review evidence outside the gate section", () => {
    const body = validBody().replace(
      `## Cross-Cutting Review Gate`,
      `${tableRow("Architect")}\n## Cross-Cutting Review Gate`,
    );
    expect(evaluateClusterReviewAttestation(pullRequest({ body })).reason).toBe(
      "review-evidence-outside-section",
    );
  });

  it("requires the role table to be one contiguous visible Markdown block", () => {
    const table = [
      "| Role | Reviewed HEAD SHA | Verdict | Blocking findings |",
      "|---|---|---|---|",
      tableRow("Architect"),
      tableRow("Critic"),
      tableRow("Security"),
    ].join("\n");

    expect(
      evaluateClusterReviewAttestation(
        pullRequest({ body: validBody().replace(table, `<!--\n${table}\n-->`) }),
      ).reason,
    ).toBe("table-not-visible");

    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: validBody().replace(
            table,
            "```markdown\n" + table + "\n```",
          ),
        }),
      ).reason,
    ).toBe("table-not-visible");

    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: validBody().replace(
            "| Role | Reviewed HEAD SHA | Verdict | Blocking findings |\n|---|---|---|---|",
            "| Role | Reviewed HEAD SHA | Verdict | Blocking findings |\ntext\n|---|---|---|---|",
          ),
        }),
      ).reason,
    ).toBe("invalid-table-block");

    expect(
      evaluateClusterReviewAttestation(
        pullRequest({ body: "```\n" + validBody() }),
      ).reason,
    ).toBe("table-not-visible");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body:
            "```markdown\n```not-a-valid-closing-fence\n" +
            validBody(),
        }),
      ).reason,
    ).toBe("table-not-visible");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: "```markdown\n\t```\n" + validBody(),
        }),
      ).reason,
    ).toBe("table-not-visible");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body:
            "```bad`info\n```\n" +
            validBody(),
        }),
      ).reason,
    ).toBe("table-not-visible");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({ body: "`\n<details>\n``\n" + validBody() }),
      ).reason,
    ).toBe("table-not-visible");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: "\\`\n<details>\n`\n" + validBody() + "\n</details>",
        }),
      ).reason,
    ).toBe("table-not-visible");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: "`\n<details>\n\\`\n" + validBody() + "\n</details>",
        }),
      ).reason,
    ).toBe("table-not-visible");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: "\\` literal\n`\n<details>\n`\n" + validBody(),
        }),
      ),
    ).toEqual({ attested: true, reason: "attested" });
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({ body: "`\n<details>\n`\n" + validBody() }),
      ),
    ).toEqual({ attested: true, reason: "attested" });
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: "prefix\n    <details>\n\n" + validBody() + "\n</details>",
        }),
      ).reason,
    ).toBe("table-not-visible");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: "    <details>\n\n" + validBody() + "\n</details>",
        }),
      ),
    ).toEqual({ attested: true, reason: "attested" });
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: "<details>\n\n    </details>\n\n" + validBody() + "\n</details>",
        }),
      ).reason,
    ).toBe("table-not-visible");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: "<details>\n\\</details>\n" + validBody() + "\n</details>",
        }),
      ).reason,
    ).toBe("table-not-visible");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({ body: "<details>\n" + validBody() + "\n</details>" }),
      ).reason,
    ).toBe("table-not-visible");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body:
            "<details>\n<!-- </details> -->\n" +
            validBody() +
            "\n</details>",
        }),
      ).reason,
    ).toBe("table-not-visible");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body:
            "<details>\n```html\n</details>\n```\n" +
            validBody() +
            "\n</details>",
        }),
      ).reason,
    ).toBe("table-not-visible");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body:
            "<details>\n<script>\n</details>\n</script>\n" +
            validBody() +
            "\n</details>",
        }),
      ).reason,
    ).toBe("table-not-visible");
  });

  it("rejects malformed or duplicate Reviewed HEAD candidates", () => {
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: validBody().replace(
            "Reviewed HEAD: `" + HEAD + "`",
            "Reviewed HEAD: `not-a-sha`",
          ),
        }),
      ).reason,
    ).toBe("invalid-reviewed-head");

    expect(
      evaluateClusterReviewAttestation(
        pullRequest({ body: validBody() + "\nReviewed HEAD: `not-a-sha`" }),
      ).reason,
    ).toBe("duplicate-reviewed-head");
  });
  it("rejects a missing exemption label", () => {
    expect(
      evaluateClusterReviewAttestation(pullRequest({ labels: [] })).reason,
    ).toBe("missing-label");
  });

  it("rejects a stale reviewed HEAD", () => {
    const body = validBody().replace(
      `Reviewed HEAD: \`${HEAD}\``,
      `Reviewed HEAD: \`${STALE_HEAD}\``,
    );
    expect(evaluateClusterReviewAttestation(pullRequest({ body })).reason).toBe(
      "stale-reviewed-head",
    );
  });

  it("rejects a missing or duplicate visible role row", () => {
    const critic = tableRow("Critic");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({ body: validBody().replace(critic, "") }),
      ).reason,
    ).toBe("invalid-table-block");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({ body: validBody().replace(critic, `${critic}\n${critic}`) }),
      ).reason,
    ).toBe("invalid-table-block");
  });

  it("rejects malformed visible role rows", () => {
    const body = validBody().replace(
      tableRow("Architect"),
      `| Architect | \`${HEAD}\` | GO | None |`,
    );
    expect(evaluateClusterReviewAttestation(pullRequest({ body })).reason).toBe(
      "invalid-table-block",
    );
  });

  it("rejects stale SHA, NO-GO, and blocking findings in the visible table", () => {
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: validBody().replace(tableRow("Architect"), tableRow("Architect", STALE_HEAD)),
        }),
      ).reason,
    ).toBe("stale-table-head:architect");

    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: validBody().replace(
            tableRow("Critic"),
            `| Critic | \`${HEAD}\` | \`NO-GO\` | details |`,
          ),
        }),
      ).reason,
    ).toBe("table-no-go:critic");

    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: validBody().replace(
            tableRow("Security"),
            `| Security | \`${HEAD}\` | \`GO\` | issue-link |`,
          ),
        }),
      ).reason,
    ).toBe("blocking-findings:security");
  });

  it("rejects a missing or duplicate hidden role marker", () => {
    const marker = `<!-- cluster-review:security:${HEAD}:GO -->`;
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({ body: validBody().replace(marker, "") }),
      ).reason,
    ).toBe("missing-role:security");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({ body: `${validBody()}\n${marker}` }),
      ).reason,
    ).toBe("duplicate-role:security");
  });

  it("rejects stale and NO-GO hidden markers", () => {
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: validBody().replace(
            `<!-- cluster-review:architect:${HEAD}:GO -->`,
            `<!-- cluster-review:architect:${STALE_HEAD}:GO -->`,
          ),
        }),
      ).reason,
    ).toBe("stale-head:architect");
    expect(
      evaluateClusterReviewAttestation(
        pullRequest({
          body: validBody().replace(
            `<!-- cluster-review:critic:${HEAD}:GO -->`,
            `<!-- cluster-review:critic:${HEAD}:NO-GO -->`,
          ),
        }),
      ).reason,
    ).toBe("no-go:critic");
  });
});
