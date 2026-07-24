import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/marketplace-e2e.yml"),
  "utf8",
);
const hostDockerfile = readFileSync(
  resolve(process.cwd(), ".github/marketplace-e2e/host.Dockerfile"),
  "utf8",
);
const epDockerfile = readFileSync(
  resolve(process.cwd(), ".github/marketplace-e2e/ep.Dockerfile"),
  "utf8",
);

function job(name: string, next?: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = next
    ? workflow.indexOf(`\n  ${next}:\n`, start + 1)
    : workflow.length;
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe("Marketplace E2E hostile-candidate containment", () => {
  it("limits repository secrets to exact, non-recursive input acquisition", () => {
    const staging = job("stage-inputs", "build-marketplace");
    expect(staging).toContain("M4_MARKETPLACE_CHECKOUT_TOKEN");
    expect(staging).toContain("ref: ${{ env.MARKETPLACE_SHA }}");
    expect(staging).toContain("ref: ${{ env.EP_API_SHA }}");
    expect(staging).toContain("submodules: false");
    expect(staging).not.toMatch(
      /bun (install|run)|uv (sync|run)|docker (build|run)/u,
    );
    expect(staging).not.toContain("submodules: recursive");

    const afterStaging = workflow.slice(
      workflow.indexOf("\n  build-marketplace:\n"),
    );
    expect(afterStaging).not.toContain("${{ secrets.");
  });

  it("never transfers EP source to the final runner", () => {
    const finalJob = job("marketplace-e2e");
    expect(finalJob).toContain("name: m4-ep-bundle");
    expect(finalJob).not.toContain("name: m4-ep-source");
    expect(finalJob).not.toContain("ep-source.tar");
    expect(finalJob).toContain("verify-output");
    expect(finalJob).toContain("kind ep-bundle");
  });

  it("runs Marketplace and Host candidates without host mounts or egress", () => {
    const finalJob = job("marketplace-e2e");
    expect(finalJob).toContain("docker network create --internal");
    expect(finalJob).toContain('--network "$NETWORK_NAME"');
    expect(finalJob).toContain('--network "container:$MARKETPLACE_CONTAINER"');
    expect(finalJob).toContain("--user 10001:10001");
    expect(finalJob).toContain("--cap-drop ALL");
    expect(finalJob).toContain("--security-opt no-new-privileges");
    expect(finalJob).not.toMatch(
      /docker (create|run)[\s\S]*?(?:-v |--volume |--mount )/u,
    );
    expect(finalJob).toContain("docker cp");
  });

  it("keeps trusted control code at workflow_sha and validates after candidate exit", () => {
    for (const name of [
      "stage-inputs",
      "build-marketplace",
      "build-ep",
      "marketplace-e2e",
    ]) {
      const block =
        name === "stage-inputs"
          ? job(name, "build-marketplace")
          : name === "build-marketplace"
            ? job(name, "build-ep")
            : name === "build-ep"
              ? job(name, "marketplace-e2e")
              : job(name);
      expect(block).toContain("ref: ${{ github.workflow_sha }}");
      expect(block).toContain("persist-credentials: false");
    }
    const finalJob = job("marketplace-e2e");
    expect(finalJob.indexOf("docker start --attach")).toBeLessThan(
      finalJob.indexOf("finalize-evidence"),
    );
    expect(finalJob).toContain("candidate-evidence-root");
  });

  it("executes Host and EP package scripts only after dropping root in build images", () => {
    for (const dockerfile of [hostDockerfile, epDockerfile]) {
      const nonRoot = dockerfile.indexOf("USER 10001:10001");
      expect(nonRoot).toBeGreaterThanOrEqual(0);
      expect(
        dockerfile.indexOf("bun install --frozen-lockfile"),
      ).toBeGreaterThan(nonRoot);
      expect(dockerfile).not.toMatch(
        /(?:SECRET|TOKEN|GITHUB_ENV|GITHUB_OUTPUT)/u,
      );
      expect(dockerfile).not.toMatch(/(?:--mount=|VOLUME\s)/u);
    }
    expect(hostDockerfile).toContain("COPY --chown=10001:10001 lvis-app/");
    expect(epDockerfile).toContain(
      "COPY --chown=10001:10001 lvis-plugin-lge-api/",
    );
  });

  it("pins every third-party action to a full commit SHA", () => {
    for (const match of workflow.matchAll(
      /^\s*uses:\s*([^@\s]+)@([^\s#]+)/gmu,
    )) {
      expect(match[2], `${match[1]} is mutable`).toMatch(/^[0-9a-f]{40}$/u);
    }
  });
});
