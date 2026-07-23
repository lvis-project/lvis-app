import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const workflow = read(".github/workflows/marketplace-e2e.yml");
const orchestrate = read("test/control/marketplace-e2e/orchestrate.sh");
const hostDockerfile = read("test/control/marketplace-e2e/Dockerfile.host");
const marketplaceDockerfile = read("test/control/marketplace-e2e/Dockerfile.marketplace");
const epDockerfile = read("test/control/marketplace-e2e/Dockerfile.ep");
const evidenceDockerfile = read("test/control/marketplace-e2e/Dockerfile.evidence");
const hostControl = read("test/control/marketplace-e2e/run-host.mjs");
const hostileControl = read("test/control/marketplace-e2e/run-hostile.mjs");
const evidenceValidator = read("test/control/marketplace-e2e/validate-evidence.mjs");
const evidenceNormalizer = read("test/control/marketplace-e2e/normalize-evidence.mjs");
const harnessManifest = read("test/control/marketplace-e2e/create-harness-manifest.mjs");
const seededElectron = read("test/e2e/ui/seeded-electron.ts");
const containment = read("test/e2e/marketplace-containment-rehearsal.test.ts");

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe("trusted marketplace E2E workflow", () => {
  it("accepts only the exact default-branch repository_dispatch trigger", () => {
    const triggers = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    expect(triggers).toContain("repository_dispatch:");
    expect(triggers).toContain("types: [marketplace-e2e]");
    for (const rejected of [
      "workflow_dispatch:",
      "pull_request:",
      "pull_request_target:",
      "push:",
      "schedule:",
      "workflow_call:",
    ]) {
      expect(triggers).not.toContain(rejected);
    }
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("pull-requests: write");
  });

  it("fails closed while resolving every same-repository PR head or exact main SHA", () => {
    const resolverStart = workflow.indexOf("- name: Resolve trusted candidate snapshot");
    const firstCheckout = workflow.indexOf("- name: Checkout exact lvis-app candidate");
    const resolver = workflow.slice(resolverStart, firstCheckout);
    expect(resolverStart).toBeGreaterThan(-1);
    expect(firstCheckout).toBeGreaterThan(resolverStart);
    for (const proof of [
      "client_payload.schema_version must be 1",
      "client_payload contains an unsupported field",
      '.state != "open"',
      ".base.repo.full_name != $repo",
      '.base.ref != "main"',
      ".head.repo.full_name != $repo",
      'test("^[0-9a-f]{40}$")',
      '"repos/$repo/compare/${resolved_sha}...main"',
      ".base_commit.sha == $resolved",
    ]) {
      expect(resolver).toContain(proof);
    }
    expect(resolver).toContain(
      'resolve_candidate "lvis-project/lvis-marketplace" "marketplace" "$PRIVATE_API_TOKEN"',
    );
    expect(resolver).toContain(
      'resolve_candidate "lvis-project/lvis-plugin-ep" "ep" "$PRIVATE_API_TOKEN"',
    );
  });

  it("uses private credentials only for trusted resolution and non-recursive exact checkout", () => {
    expect(count(workflow, "secrets.M4_MARKETPLACE_CHECKOUT_TOKEN")).toBe(3);
    expect(count(workflow, "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0")).toBe(4);
    expect(count(workflow, "fetch-depth: 0")).toBe(4);
    expect(count(workflow, "persist-credentials: false")).toBe(4);
    expect(count(workflow, "submodules: false")).toBe(4);
    expect(count(workflow, "lfs: false")).toBe(4);
    expect(workflow).not.toContain("submodules: recursive");
    expect(workflow).not.toContain("git submodule");

    const afterCredentialProof = workflow.slice(
      workflow.indexOf("- name: Prove candidate checkout credentials are isolated"),
    );
    expect(afterCredentialProof).not.toContain("M4_MARKETPLACE_CHECKOUT_TOKEN");
    expect(afterCredentialProof).not.toContain("PRIVATE_API_TOKEN");
    expect(afterCredentialProof).not.toContain("PUBLIC_API_TOKEN");
    expect(afterCredentialProof).toContain(".gitmodules must remain inert regular data");
    expect(afterCredentialProof).toContain("sha256sum \"$repo/.gitmodules\"");
    expect(afterCredentialProof).toContain(
      "tar -xf .control/snapshots/sdk.tar",
    );
    expect(afterCredentialProof).toContain(
      ".control/contexts/marketplace/vendor/lvis-plugin-sdk",
    );
  });

  it("pins every action and the trusted harness to github.workflow_sha", () => {
    const actionRefs = [...workflow.matchAll(/uses:\s+([^\s]+)/gu)].map((match) => match[1]);
    expect(actionRefs.length).toBe(5);
    for (const ref of actionRefs) {
      expect(ref).toMatch(/^[^@]+@[0-9a-f]{40}$/u);
    }
    expect(workflow).toContain("CONTROL_SHA: ${{ github.workflow_sha }}");
    expect(workflow).toContain("https://github.com/lvis-project/lvis-app.git");
    expect(workflow).toContain("-c credential.helper=");
    expect(workflow).toContain("-c http.extraHeader=");
    expect(workflow).toContain("GIT_CONFIG_GLOBAL=/dev/null");
    expect(workflow).toContain("GIT_CONFIG_SYSTEM=/dev/null");
    expect(workflow).toContain('test "$(git -C .control/trusted rev-parse HEAD)" = "$CONTROL_SHA"');
  });

  it("seals clean commit, tree, archive, tar digest, and inert gitmodules bindings locally", () => {
    for (const proof of [
      "git -C \"$repo\" archive --format=tar HEAD",
      "git -C \"$repo\" rev-parse 'HEAD^{tree}'",
      "archiveSha256",
      "gitmodulesSha256",
      "validate_archive \"$archive\"",
      "Candidate archive contained Git metadata",
      "input-bindings.json",
      "sdkSchemaSha256",
      "plugin-bundle-e2e-inputs.mjs",
      "create-harness-manifest.mjs",
    ]) {
      expect(workflow).toContain(proof);
    }
    const upload = workflow.slice(workflow.indexOf("- name: Upload validated public evidence only"));
    expect(upload).toContain("path: .control/export/validated-summary.json");
    expect(upload).not.toContain("*.json");
    expect(upload).not.toContain("snapshots");
    expect(upload).not.toContain("contexts");
    expect(upload).not.toContain("artifacts");
    expect(upload).not.toContain("private-logs");
  });

  it("never executes candidate code or candidate package test scripts on the runner host", () => {
    const afterCheckouts = workflow.slice(
      workflow.indexOf("- name: Prove candidate checkout credentials are isolated"),
    );
    expect(afterCheckouts).not.toContain("working-directory: .candidate");
    expect(afterCheckouts).not.toMatch(/\bbun run\b/u);
    expect(afterCheckouts).not.toMatch(/\buv run\b/u);
    expect(afterCheckouts).not.toContain("print_test_poc_signer_env.py");
    expect(afterCheckouts).not.toContain(">> \"$GITHUB_ENV\"");
    expect(afterCheckouts).toContain(
      "bash .control/trusted/test/control/marketplace-e2e/orchestrate.sh",
    );
    expect(hostControl).not.toContain("package.json");
    expect(hostControl).not.toContain("bun run");
    expect(hostControl).not.toContain("npm test");
    expect(hostControl).toContain("/trusted/runner/scripts/run-vitest-under-electron.mjs");
    expect(hostControl).toContain("/trusted/runner/node_modules/@playwright/test/cli.js");
    expect(hostDockerfile).toContain(
      'ENTRYPOINT ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x1024x24"',
    );
  });

  it("builds candidates in separate sealed contexts with networkless candidate RUN steps", () => {
    for (const [name, source] of [
      ["Host", hostDockerfile],
      ["Marketplace", marketplaceDockerfile],
      ["EP", epDockerfile],
    ] as const) {
      expect(source).toContain("COPY --from=candidate");
      expect(source).toContain("RUN --network=none");
      const candidateRun = source.indexOf("RUN --network=none");
      const firstTrustedCopy = source.indexOf("COPY --from=control");
      expect(candidateRun, `${name} candidate RUN`).toBeGreaterThan(-1);
      expect(firstTrustedCopy, `${name} trusted copy`).toBeGreaterThan(candidateRun);
    }
    expect(orchestrate).toContain(
      '--build-context "candidate=$candidate_context"',
    );
    expect(orchestrate).toContain('--build-context "control=$control_root"');
    expect(orchestrate).not.toContain("--build-context candidate=$workspace");
    expect(orchestrate).not.toContain("/var/run/docker.sock");
    expect(orchestrate).not.toContain("docker logs");
    expect(orchestrate).toContain('>"$log" 2>&1');
    expect(orchestrate).toContain("private log retained only on runner");
  });

  it("removes candidate tests before overlaying and digest-verifying the full trusted closure", () => {
    const remove = hostDockerfile.indexOf("rm -rf /candidate/app/test/e2e");
    const overlay = hostDockerfile.indexOf(
      "COPY --from=control --chown=10001:10001 test/e2e /candidate/app/test/e2e",
    );
    const verify = hostDockerfile.lastIndexOf("verify-harness.mjs");
    expect(remove).toBeGreaterThan(-1);
    expect(overlay).toBeGreaterThan(remove);
    expect(verify).toBeGreaterThan(overlay);
    expect(harnessManifest).toContain('"ls-tree", "-r", "-z"');
    expect(harnessManifest).toContain("test/e2e/ui/ep-attendance-live.spec.ts");
    expect(harnessManifest).toContain("test/e2e/ui/marketplace-live-lifecycle.spec.ts");
    expect(hostControl).toContain("harness-integrity");
    expect(seededElectron).toContain("CANDIDATE_APP_ROOT");
    expect(seededElectron).toContain("CANDIDATE_APP_ROOT must be an absolute path");
  });

  it("runs only non-root, capability-free, read-only containers on an internal network", () => {
    expect(orchestrate).toContain("docker network create --internal");
    for (const flag of [
      "--user 10001:10001",
      "--user 10002:10002",
      "--user 10003:10003",
      "--read-only",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--pids-limit",
      "--memory",
      "--cpus",
      "--tmpfs /tmp:rw,noexec,nosuid",
    ]) {
      expect(orchestrate).toContain(flag);
    }
    expect(orchestrate).not.toContain("--privileged");
    expect(orchestrate).not.toContain("--network host");
    const hostileRun = orchestrate.slice(
      orchestrate.indexOf("/trusted/control/run-hostile.mjs") - 600,
      orchestrate.indexOf("/trusted/control/run-hostile.mjs") + 100,
    );
    const hostRun = orchestrate.slice(
      orchestrate.indexOf('--name "$host_container"'),
      orchestrate.indexOf("host_exit=$?"),
    );
    for (const run of [hostileRun, hostRun]) {
      expect(run).toContain("type=volume");
      expect(run).not.toContain("type=bind");
      expect(run).not.toContain("/var/run/docker.sock");
    }
    expect(hostileControl).toContain("CapEff:");
    expect(hostileControl).toContain("/var/run/docker.sock");
    expect(hostileControl).toContain("externalEgressBlocked");
    expect(hostileControl).toContain("internalMarketplaceReachable");
    expect(hostileControl).toContain("rootReadOnly");
    for (const proof of [
      "GITHUB_ENV",
      "GITHUB_PATH",
      "GITHUB_TOKEN",
      "M4_MARKETPLACE_CHECKOUT_TOKEN",
      "PRIVATE_API_TOKEN",
      'spawn("sudo", ["-n", "true"]',
      "/trusted/control/.hostile-control-write",
      "/workspace/.hostile-sibling-write",
      "/host-marker",
      "sealedInputMutationBlocked",
    ]) {
      expect(hostileControl).toContain(proof);
    }
  });

  it("keeps candidate output private and emits only trusted bounded summaries", () => {
    expect(hostControl).toContain("/tmp/private-logs/");
    expect(hostControl).toContain('stdio: ["ignore", log.fd, log.fd]');
    expect(hostControl).not.toContain('stdio: "inherit"');
    expect(hostControl).toContain("trusted phase ${label}: ok");
    expect(orchestrate).toContain('private_logs="$run_root/private-logs"');
    expect(orchestrate).not.toContain("tail ");
    expect(orchestrate).not.toContain("cat \"$private_logs");
  });

  it("uses a named evidence volume and a separate trusted validator export", () => {
    const upload = workflow.slice(
      workflow.indexOf("- name: Upload validated public evidence only"),
    );
    expect(orchestrate).toContain('docker volume create "$evidence_volume"');
    expect(orchestrate).toContain('type=volume,src=$evidence_volume,dst=/evidence');
    expect(orchestrate).toContain("/trusted/control/normalize-evidence.mjs");
    expect(orchestrate).toContain("/trusted/control/validate-evidence.mjs /evidence /export");
    expect(orchestrate).toContain('type=bind,src=$export_root,dst=/export');
    const normalizerRun = orchestrate.slice(
      orchestrate.indexOf('runner_uid="$(id -u)"'),
      orchestrate.indexOf("/trusted/control/normalize-evidence.mjs") + 80,
    );
    expect(normalizerRun).toContain("--network none");
    expect(normalizerRun).toContain("--user 0:0");
    expect(normalizerRun).toContain("--cap-drop ALL");
    expect(normalizerRun).toContain("--cap-add CHOWN");
    expect(normalizerRun).toContain("--cap-add FOWNER");
    expect(evidenceDockerfile).toContain("chmod 1733 /evidence");
    expect(evidenceDockerfile).toContain("--chown=0:0 --chmod=0444");
    expect(evidenceDockerfile).toContain("USER 10003:10003");
    expect(evidenceNormalizer).toContain(
      '["host-lifecycle.json", { uid: 10001, gid: 10001, mode: 0o600 }]',
    );
    expect(evidenceNormalizer).toContain(
      '["hostile-containment.json", { uid: 10002, gid: 10002, mode: 0o600 }]',
    );
    expect(evidenceNormalizer).toContain(
      '["container-exits.json", { uid: 10003, gid: 10003, mode: 0o600 }]',
    );
    for (const proof of [
      "lstat",
      "realpath",
      "stat.nlink !== 1",
      "isSymbolicLink",
      "missing or unknown",
      "size budget",
      "stat.uid",
      "stat.mode",
      "replay binding",
      "container exit or image replay binding",
      "attendance read-write-readback",
      "containment evidence is not fail-closed",
      "externalEgressBlocked",
      "flag: \"wx\"",
    ]) {
      expect(`${evidenceNormalizer}\n${evidenceValidator}`).toContain(proof);
    }
    expect(evidenceValidator).toContain('resolve(exportRoot, "validated-summary.json")');
    expect(evidenceValidator).toContain('exportedNames.length !== 1');
    expect(evidenceValidator).toContain("attendanceReadVerified: true");
    expect(evidenceValidator).toContain("attendanceWriteVerified: true");
    expect(evidenceValidator).not.toContain("attendanceCalendarReads:");
    expect(evidenceValidator).not.toContain("attendanceCalendarWrites:");
    for (const raw of [
      "input-bindings.json",
      "control-harness-manifest.json",
      "image-digests.json",
      "input-contract.json",
      "host-lifecycle.json",
      "hostile-containment.json",
      "container-exits.json",
    ]) {
      expect(upload).not.toContain(raw);
    }
  });

  it("retains schema, installer, Electron IPC, attendance, and reverse-containment proof names", () => {
    for (const proof of [
      "plugin-bundle-e2e-inputs.mjs",
      "marketplace-e2e.test.ts",
      "marketplace-live-lifecycle.spec.ts",
      "ep-attendance-live.spec.ts",
      "marketplace-containment-rehearsal.test.ts",
      "SDK_EVIDENCE_PATH",
      "explicitConfirmation",
      "read-write-readback",
      "zeroOrphans",
    ]) {
      expect(
        `${workflow}\n${hostControl}\n${containment}\n${evidenceValidator}`,
      ).toContain(proof);
    }
  });
});
