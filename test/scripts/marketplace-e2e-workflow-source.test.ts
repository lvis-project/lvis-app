import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  ".github/workflows/marketplace-e2e.yml",
  "utf8",
);

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe("trusted marketplace E2E workflow", () => {
  it("runs only from default-branch repository_dispatch code", () => {
    expect(workflow).toContain("repository_dispatch:");
    expect(workflow).toContain("types: [marketplace-e2e]");
    expect(workflow).not.toContain("\n  workflow_dispatch:");
    expect(workflow).not.toContain("\n  pull_request:");
    expect(workflow).not.toContain("\n  pull_request_target:");
    expect(workflow).not.toContain("\n  schedule:");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("pull-requests: write");
  });

  it("fails closed while resolving every PR head before checkout", () => {
    const resolverStart = workflow.indexOf(
      "      - name: Resolve trusted candidate snapshot",
    );
    const firstCheckout = workflow.indexOf(
      "      - name: Checkout exact lvis-app candidate",
    );
    const resolver = workflow.slice(resolverStart, firstCheckout);

    expect(resolverStart).toBeGreaterThan(-1);
    expect(firstCheckout).toBeGreaterThan(resolverStart);
    expect(resolver).toContain("client_payload.schema_version must be 1");
    expect(resolver).toContain("client_payload contains an unsupported field");
    expect(resolver).toContain('if [[ -n "$pr_number" && -n "$main_sha" ]]');
    expect(resolver).toContain('if [[ -z "$pr_number" && -z "$main_sha" ]]');
    expect(resolver).toContain('response="$(api_with_token "$token" "repos/$repo/pulls/$pr_number")"');
    expect(resolver).toContain('.state != "open"');
    expect(resolver).toContain('.base.repo.full_name != $repo');
    expect(resolver).toContain('.base.ref != "main"');
    expect(resolver).toContain('.head.repo.full_name != $repo');
    expect(resolver).toContain('test("^[0-9a-f]{40}$")');
    expect(resolver).toContain(
      'resolve_candidate "lvis-project/lvis-app" "host" "$PUBLIC_API_TOKEN"',
    );
    expect(resolver).toContain(
      'resolve_candidate "lvis-project/lvis-marketplace" "marketplace" "$PRIVATE_API_TOKEN"',
    );
    expect(resolver).toContain(
      'resolve_candidate "lvis-project/lvis-plugin-sdk" "sdk" "$PUBLIC_API_TOKEN"',
    );
    expect(resolver).toContain(
      'resolve_candidate "lvis-project/lvis-plugin-ep" "ep" "$PRIVATE_API_TOKEN"',
    );

    const prResolver = resolver.slice(
      resolver.indexOf("          resolve_pr()"),
      resolver.indexOf("          resolve_main_sha()"),
    );
    expect(prResolver).not.toContain("/compare/");
    expect(prResolver).not.toContain("merge-base");
    expect(prResolver).not.toContain("is-ancestor");

    const mainResolver = resolver.slice(
      resolver.indexOf("          resolve_main_sha()"),
      resolver.indexOf("          resolve_candidate()"),
    );
    expect(mainResolver).toContain(
      '"repos/$repo/compare/${resolved_sha}...main"',
    );
    expect(mainResolver).toContain('.status == "ahead"');
    expect(mainResolver).toContain('.status == "identical"');
    expect(mainResolver).toContain(".base_commit.sha == $resolved");
  });

  it("checks out only exact resolved SHAs without persisting credentials", () => {
    for (const output of [
      "host_sha",
      "marketplace_sha",
      "sdk_sha",
      "ep_sha",
    ]) {
      expect(workflow).toContain(`ref: \${{ steps.candidates.outputs.${output} }}`);
    }
    expect(count(workflow, "fetch-depth: 0")).toBe(4);
    expect(count(workflow, "persist-credentials: false")).toBe(4);
    expect(count(workflow, "secrets.M4_MARKETPLACE_CHECKOUT_TOKEN")).toBe(3);
    expect(workflow).not.toContain("actions/checkout@v7");
    expect(count(
      workflow,
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
    )).toBe(4);
  });

  it("removes checkout credential surfaces before candidate code runs", () => {
    const isolationStart = workflow.indexOf(
      "      - name: Prove candidate checkout credentials are isolated",
    );
    const immutableStart = workflow.indexOf(
      "      - name: Prove immutable checkout refs",
    );
    const candidateExecutionStart = workflow.indexOf(
      "      - name: Install marketplace server deps",
    );
    const isolation = workflow.slice(isolationStart, immutableStart);
    const candidateExecution = workflow.slice(candidateExecutionStart);

    expect(isolationStart).toBeGreaterThan(-1);
    expect(immutableStart).toBeGreaterThan(isolationStart);
    expect(candidateExecutionStart).toBeGreaterThan(immutableStart);
    expect(isolation).toContain("http\\..*\\.extraheader");
    expect(isolation).toContain("credential\\..*");
    expect(isolation).toContain('^https?://[^/]*@');
    expect(isolation).toContain("submodule foreach --quiet --recursive");
    expect(candidateExecution).not.toContain(
      "secrets.M4_MARKETPLACE_CHECKOUT_TOKEN",
    );
    expect(candidateExecution).not.toContain("PRIVATE_API_TOKEN");
    expect(candidateExecution).not.toContain("PUBLIC_API_TOKEN");
    expect(candidateExecution).not.toMatch(/\bgit\b[^\n]*\bfetch\b/u);
  });

  it("keeps immutable schema, lifecycle, attendance, and containment proofs", () => {
    for (const step of [
      "Prove immutable checkout refs",
      "Prove consumed SDK and cross-repository schema identity",
      "Run live installer transport proof",
      "Run live Electron IPC lifecycle",
      "Run exact EP attendance read-write-readback lifecycle",
      "Run loopback reverse-containment rehearsal",
      "Upload immutable-ref evidence",
    ]) {
      expect(workflow).toContain(`- name: ${step}`);
    }
  });
});
