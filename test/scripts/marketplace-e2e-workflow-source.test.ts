import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const workflow = read(".github/workflows/marketplace-e2e.yml");
const orchestrate = read("test/control/marketplace-e2e/orchestrate.sh");
const hostDockerfile = read("test/control/marketplace-e2e/Dockerfile.host");
const marketplaceDockerfile = read("test/control/marketplace-e2e/Dockerfile.marketplace");
const epDockerfile = read("test/control/marketplace-e2e/Dockerfile.ep");
const dependencyProxyDockerfile = read(
  "test/control/marketplace-e2e/Dockerfile.dependency-proxy",
);
const dependencyBunDockerfile = read(
  "test/control/marketplace-e2e/Dockerfile.dependency-bun",
);
const dependencyUvDockerfile = read(
  "test/control/marketplace-e2e/Dockerfile.dependency-uv",
);
const dependencyProxy = read(
  "test/control/marketplace-e2e/dependency-connect-proxy.mjs",
);
const evidenceDockerfile = read("test/control/marketplace-e2e/Dockerfile.evidence");
const hostControl = read("test/control/marketplace-e2e/run-host.mjs");
const hostileControl = read("test/control/marketplace-e2e/run-hostile.mjs");
const evidenceValidator = read("test/control/marketplace-e2e/validate-evidence.mjs");
const evidenceNormalizer = read("test/control/marketplace-e2e/normalize-evidence.mjs");
const harnessManifest = read("test/control/marketplace-e2e/create-harness-manifest.mjs");
const candidateMaterializer = read(
  "test/control/marketplace-e2e/materialize-candidate-tree.mjs",
);
const dependencyVerifier = read(
  "test/control/marketplace-e2e/verify-trusted-dependencies.mjs",
);
const marketplacePythonInputVerifier = read(
  "test/control/marketplace-e2e/verify-marketplace-python-inputs.py",
);
const trustedRunnerPackage = read("test/control/marketplace-e2e/runner-package.json");
const trustedRunnerDependencies = (JSON.parse(trustedRunnerPackage) as {
  dependencies: Record<string, string>;
}).dependencies;
const hostAttestationWriter = read(
  "test/control/marketplace-e2e/write-host-attestation.mjs",
);
const seededElectron = read("test/e2e/ui/seeded-electron.ts");
const attendance = read("test/e2e/ui/ep-attendance-live.spec.ts");
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
    expect(afterCredentialProof).toContain("materialize-candidate-tree.mjs");
    expect(afterCredentialProof).toContain("--source-context .control/contexts/sdk");
    expect(afterCredentialProof).toContain("--destination-root .control/contexts/marketplace");
    expect(afterCredentialProof).toContain("--destination vendor/lvis-plugin-sdk");
    expect(afterCredentialProof).not.toContain("tar -xf");
    expect(afterCredentialProof).not.toContain("git archive");
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

  it("materializes exact Git tree blobs and records deterministic sealed bindings locally", () => {
    for (const proof of [
      "materialize_repo host .candidate/host \"$HOST_SHA\"",
      "materialize_repo marketplace .candidate/marketplace \"$MARKETPLACE_SHA\"",
      '--allow-gitlink "vendor/lvis-plugin-sdk=$SDK_SHA"',
      "--manifest \".control/snapshots/${name}.tree.json\"",
      "--destination-manifest .control/snapshots/marketplace.tree.json",
      "--evidence .control/snapshots/sdk-overlay.json",
      "sdkOverlay:$sdkOverlay[0]",
      "input-bindings.json",
      "sdkSchemaSha256",
      "plugin-bundle-e2e-inputs.mjs",
      "create-harness-manifest.mjs",
    ]) {
      expect(workflow).toContain(proof);
    }
    for (const proof of [
      '"ls-tree", "-rz", "--full-tree", "-t", "HEAD"',
      '"cat-file", "--batch"',
      "archiveSha256",
      "gitmodulesSha256",
      'entry.mode === "120000"',
      'entry.mode === "160000"',
      "root .dockerignore may filter",
      "O_NOFOLLOW",
      "stat.nlink !== 1",
      "verifyMaterializedTree",
      "overlayMaterializedTree",
    ]) {
      expect(candidateMaterializer).toContain(proof);
    }
    expect(evidenceValidator).toContain(
      'bindings.sdkOverlay.targetPath !== "vendor/lvis-plugin-sdk"',
    );
    expect(evidenceValidator).toContain(
      "bindings.sdkOverlay.gitlinkOid !== bindings.inputs.sdk.commit",
    );
    expect(evidenceValidator).toContain(
      "bindings.sdkOverlay.sdkTree !== bindings.inputs.sdk.tree",
    );
    expect(evidenceValidator).toContain(
      "bindings.sdkOverlay.sdkArchiveSha256 !== bindings.inputs.sdk.archiveSha256",
    );
    expect(orchestrate).toContain(
      "'.sdkOverlay.imageInputArchiveSha256'",
    );
    expect(orchestrate).toContain(
      '--build-arg "CANDIDATE_INPUT_SHA256=$marketplace_input_sha"',
    );
    expect(orchestrate).toContain(
      '"ai.lvis.candidate-input-sha256"',
    );
    expect(orchestrate).toContain(
      '"$observed_marketplace_input_sha" == "$marketplace_input_sha"',
    );
    expect(marketplaceDockerfile).toContain(
      'LABEL ai.lvis.candidate-input-sha256="${CANDIDATE_INPUT_SHA256}"',
    );
    expect(candidateMaterializer).not.toContain("git archive");
    expect(candidateMaterializer).not.toContain("tar -xf");
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
      expect(source).toContain("COPY --from=dependencies");
      const candidateStart = source.indexOf(" AS candidate-build");
      const candidateStage = source.slice(
        candidateStart,
        source.indexOf("\nFROM ", candidateStart + 1),
      );
      expect(candidateStart, `${name} candidate stage`).toBeGreaterThan(-1);
      expect(candidateStage).toContain("RUN --network=none");
      expect(candidateStage).not.toContain("COPY --from=control");
    }
    expect(hostDockerfile).toContain("FROM ${PLAYWRIGHT_IMAGE} AS native-toolchain");
    expect(hostDockerfile).toContain("build-essential");
    expect(hostDockerfile).toContain("node-gyp install");
    expect(hostDockerfile).toContain("--target=43.0.0");
    expect(hostDockerfile).toContain("--devdir=/root/.electron-gyp");
    expect(hostDockerfile).toContain("/root/.electron-gyp/43.0.0");
    expect(hostDockerfile).toContain("--force --sequential");
    expect(workflow).toContain('[[ "$host_electron_lock" == "43.0.0" ]]');
    expect(orchestrate).toContain(
      '--build-context "candidate=$candidate_context"',
    );
    expect(orchestrate).toContain('--build-context "control=$control_root"');
    expect(orchestrate).toContain(
      '--build-context "dependencies=docker-image://$host_dependency_image"',
    );
    expect(orchestrate).toContain(
      '--build-context "dependencies=docker-image://$ep_dependency_image"',
    );
    expect(orchestrate).toContain(
      '--build-context "dependencies=docker-image://$marketplace_dependency_image"',
    );
    expect(orchestrate).not.toContain("--build-context candidate=$workspace");
    expect(orchestrate).not.toContain("/var/run/docker.sock");
    expect(orchestrate).not.toContain("docker logs");
    expect(orchestrate).toContain('>"$log" 2>&1');
    expect(orchestrate).toContain("private log retained only on runner");
  });

  it("moves candidate dependency downloads behind isolated input-only downloaders", () => {
    for (const source of [marketplaceDockerfile, epDockerfile]) {
      expect(source).not.toContain("bun install");
      expect(source).not.toContain("uv sync");
      expect(source).not.toContain("--mount=type=cache");
    }
    expect(count(hostDockerfile, "bun install")).toBe(1);
    expect(hostDockerfile).not.toContain("lvis-m4-host-candidate-bun");
    expect(hostDockerfile).not.toContain("COPY --from=candidate package.json bun.lock");
    expect(dependencyBunDockerfile).toContain("COPY --from=input");
    expect(dependencyBunDockerfile).toContain("BUN_INSTALL_CACHE_DIR=/deps/.cache/bun");
    expect(dependencyUvDockerfile).toContain("COPY --from=input");
    expect(dependencyUvDockerfile).toContain("UV_CACHE_DIR=/deps/.cache/uv");
    expect(dependencyProxyDockerfile).toContain(
      'ENTRYPOINT ["bun", "/trusted/dependency-connect-proxy.mjs"]',
    );
    for (const proof of [
      'docker network create --internal',
      'dependency_fetch_network="lvis-dependency-fetch-${suffix}"',
      "--dns 127.0.0.1",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      '"ALLOWED_CLIENT_IP=$allowed_client_ip"',
      '"PROXY_BIND_ADDRESS=$ip"',
      "registry.npmjs.org,github.com,api.github.com,codeload.github.com",
      "pypi.org,files.pythonhosted.org",
      "docker commit",
      "'{{json .Mounts}}'",
      "dependency image tag changed during candidate build",
      "ai.lvis.dependency-image-id",
      "ai.lvis.dependency-input-sha256",
    ]) {
      expect(orchestrate).toContain(proof);
    }
    for (const proof of [
      "CONNECT authority is malformed",
      "CONNECT target is not allowlisted",
      "DNS returned an absent or non-global address",
      "allowedClientIp",
      "host: address",
      'server.listen(port, bindAddress',
    ]) {
      expect(dependencyProxy).toContain(proof);
    }
    const trustedRunnerStart = hostDockerfile.indexOf(
      "FROM native-toolchain AS trusted-runner",
    );
    const trustedRunner = hostDockerfile.slice(
      trustedRunnerStart,
      hostDockerfile.indexOf("\nFROM ", trustedRunnerStart + 1),
    );
    expect(trustedRunnerStart).toBeGreaterThan(-1);
    expect(trustedRunner).toContain("RUN bun install --frozen-lockfile");
    expect(trustedRunner).not.toContain("--mount=type=cache");
    expect(trustedRunner).not.toContain("/root/.bun/install/cache");
  });

  it("installs Marketplace dependencies only from pre-built registry wheels", () => {
    const verifyInputs = dependencyUvDockerfile.indexOf(
      "RUN --network=none python3 /trusted/verify-marketplace-python-inputs.py",
    );
    const sync = dependencyUvDockerfile.indexOf('"uv", "sync"');

    expect(verifyInputs).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(verifyInputs);
    for (const flag of [
      "--locked",
      "--no-build",
      "--no-config",
      "--no-sources",
      "--no-install-project",
      "--no-install-workspace",
      "--no-python-downloads",
      "--default-index https://pypi.org/simple",
      "--keyring-provider disabled",
      "--link-mode copy",
    ]) {
      expect(dependencyUvDockerfile.replaceAll('", "', " ")).toContain(flag);
    }
    expect(dependencyUvDockerfile).not.toContain("--frozen");
    expect(marketplacePythonInputVerifier).toContain(
      'if source == {"editable": "."}:',
    );
    expect(marketplacePythonInputVerifier).toContain(
      'set(source) != {"registry"}',
    );
    expect(marketplacePythonInputVerifier).toContain(
      "must provide at least one pre-built wheel",
    );
    expect(marketplacePythonInputVerifier).toContain(
      "tool.uv.sources is forbidden",
    );
    expect(marketplacePythonInputVerifier).toContain(
      'url != "https://pypi.org/simple"',
    );
    expect(marketplacePythonInputVerifier).toContain(
      'parsed.hostname != "files.pythonhosted.org"',
    );
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
    expect(harnessManifest).toContain(
      "test/control/marketplace-e2e/dependency-connect-proxy.mjs",
    );
    expect(harnessManifest).toContain("src/shared/llm-vendor-defaults.ts");
    expect(harnessManifest).toContain("src/shared/theme-bundles.ts");
    expect(hostDockerfile).toContain(
      "src/shared/llm-vendor-defaults.ts /candidate/app/src/shared/llm-vendor-defaults.ts",
    );
    expect(hostDockerfile).toContain(
      "src/shared/theme-bundles.ts /candidate/app/src/shared/theme-bundles.ts",
    );
    for (const dependency of [
      "@modelcontextprotocol/ext-apps",
      "@playwright/test",
      "adm-zip",
      "electron",
      "esbuild",
      "node-gyp",
      "playwright",
      "vitest",
    ]) {
      expect(trustedRunnerPackage).toContain(`"${dependency}"`);
      expect(hostDockerfile).toContain(`/trusted/runner/node_modules/${dependency}`);
    }
    expect(trustedRunnerDependencies).toEqual({
      "@modelcontextprotocol/ext-apps": "1.7.4",
      "@playwright/test": "1.60.0",
      "adm-zip": "0.6.0",
      electron: "43.0.0",
      esbuild: "0.28.0",
      "node-gyp": "12.3.0",
      playwright: "1.60.0",
      vitest: "4.1.6",
    });
    expect(hostControl).toContain("trusted-dependency-closure");
    expect(dependencyVerifier).toContain("createRequire(pathToFileURL(candidateTest))");
    expect(dependencyVerifier).toContain("await realpath(requireFromTrustedTest.resolve(entry.name))");
    expect(dependencyVerifier).toContain("manifestHash !== entry.packageJsonSha256");
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
    expect(hostileRun).toContain("type=volume,src=$evidence_volume,dst=/evidence");
    expect(hostRun).toContain("type=volume,src=$artifacts_volume,dst=/artifacts,readonly");
    expect(hostRun).not.toContain("$evidence_volume");
    expect(hostRun).not.toContain("/evidence");
    expect(hostRun).toContain("BUNDLE_E2E_EVIDENCE_PATH=/tmp/private-evidence.json");
    for (const run of [hostileRun, hostRun]) {
      expect(run).not.toContain("type=bind");
      expect(run).not.toContain("/var/run/docker.sock");
    }
    expect(orchestrate).toContain("--dns 127.0.0.1");
    expect(orchestrate).toContain("--dns-option timeout:1");
    expect(orchestrate).toContain("--dns-option attempts:1");
    expect(orchestrate).toContain('--add-host "marketplace:$marketplace_ip"');
    expect(orchestrate).toContain("address.is_private");
    expect(orchestrate).toContain("address.is_link_local");
    const marketplaceRun = orchestrate.slice(
      orchestrate.indexOf('docker run -d \\\n  --name "$marketplace_container"'),
      orchestrate.indexOf("marketplace_network_count="),
    );
    expect(marketplaceRun).toContain("--dns 127.0.0.1");
    expect(marketplaceRun).toContain("--dns-option timeout:1");
    expect(marketplaceRun).toContain("--dns-option attempts:1");
    expect(hostileControl).toContain("CapEff:");
    expect(hostileControl).toContain("/var/run/docker.sock");
    expect(hostileControl).toContain("externalEgressBlocked");
    expect(hostileControl).toContain("externalDnsBlocked");
    expect(hostileControl).toContain(".invalid");
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
      '["host-attestation.json", { uid: 10003, gid: 10003, mode: 0o600 }]',
    );
    expect(evidenceNormalizer).not.toContain("host-lifecycle.json");
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
      "Host attestation does not match trusted exit facts",
      "externalEgressBlocked",
      "flag: \"wx\"",
    ]) {
      expect(`${evidenceNormalizer}\n${evidenceValidator}`).toContain(proof);
    }
    expect(evidenceValidator).toContain('resolve(exportRoot, "validated-summary.json")');
    expect(evidenceValidator).toContain('exportedNames.length !== 1');
    expect(evidenceValidator).toContain("attendanceReadWriteReadbackVerified: true");
    expect(evidenceValidator).toContain("hostAttestation: await digest");
    expect(evidenceValidator).not.toContain("host-lifecycle.json");
    expect(hostAttestationWriter).toContain("process.getuid?.() !== 10003");
    expect(orchestrate).toContain("/trusted/control/write-host-attestation.mjs");
    for (const raw of [
      "input-bindings.json",
      "control-harness-manifest.json",
      "image-digests.json",
      "input-contract.json",
      "host-attestation.json",
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
        `${workflow}\n${hostControl}\n${attendance}\n${containment}\n${evidenceValidator}`,
      ).toContain(proof);
    }
  });
});
