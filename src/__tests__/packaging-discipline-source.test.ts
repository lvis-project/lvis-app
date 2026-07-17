import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("installer smoke and packaging discipline", () => {
  it("smoke-launches the packaged app before uploading installer artifacts", () => {
    const workflow = readRepoFile(".github/workflows/build-installers.yml");
    const smokeScript = readRepoFile("scripts/smoke-packaged-app.mjs");

    expect(workflow).toContain("Smoke launch packaged app");
    expect(workflow).toContain("scripts/smoke-packaged-app.mjs --target");
    expect(workflow).toContain("xvfb-run -a");
    expect(workflow).toContain("sudo apt-get update && sudo apt-get install -y fakeroot rpm xvfb");
    expect(workflow).toContain("actions/cache@v6");
    expect(workflow).toContain("~/.bun/install/cache");
    expect(workflow).toContain("ELECTRON_BUILDER_CACHE");
    expect(workflow).toContain("--skip-native-rebuild");
    expect(workflow.indexOf("Smoke launch packaged app")).toBeLessThan(workflow.indexOf("Upload installers"));

    expect(smokeScript).toContain("ERR_MODULE_NOT_FOUND");
    expect(smokeScript).toContain("Cannot find package");
    expect(smokeScript).toContain("linux-unpacked");
    expect(smokeScript).toContain("/^linux-.+-unpacked$/u");
    expect(smokeScript).toContain("linux-${process.arch}-unpacked");
    expect(smokeScript).toContain("win-unpacked");
    expect(smokeScript).toContain(".app");
    expect(smokeScript).toContain("LVIS_HOME");
    expect(smokeScript).toContain("assertPackagedFirstLaunchSeed");
    expect(smokeScript).toContain("assertUpgradeProbe");
    expect(smokeScript).toContain("expectedSeededMarkdownFiles");
    expect(smokeScript).toContain('join(root, "resources", subdir)');
    expect(smokeScript).toContain('["agents", "skills", "prompts"]');
    expect(smokeScript).toContain("skills");
    expect(smokeScript).toContain("prompts");
  });


  it("runs the NSIS smoke before win-unpacked and owner-cleans HKCU afterward", () => {
    const smoke = readRepoFile("scripts/smoke-packaged-app.mjs");
    const installerSmoke = smoke.indexOf(
      "await runWindowsInstallerSmoke(releaseDir, timeoutMs)",
    );
    const unpackedSmoke = smoke.indexOf(
      "await launchSmoke(executable, timeoutMs)",
    );

    expect(installerSmoke).toBeGreaterThanOrEqual(0);
    expect(unpackedSmoke).toBeGreaterThan(installerSmoke);
    expect(
      smoke.lastIndexOf("cleanupOwnedWindowsProtocolHandler(executable)"),
    ).toBeGreaterThan(smoke.indexOf("} finally {"));
    const launchBody = smoke.slice(
      smoke.indexOf("async function launchSmoke"),
      smoke.indexOf("async function runWindowsInstallerSmoke"),
    );
    expect(launchBody.indexOf(
      "assertWindowsPerMachineMarkerAbsent(executable)",
    )).toBeLessThan(launchBody.indexOf("runPackagedAppOnce"));
    expect(smoke).toContain(".lvis-nsis-per-machine-v1");
    expect(smoke).toContain(
      "lstatSync(markerPath, { throwIfNoEntry: false })",
    );
    expect(readRepoFile("src/main/lvis-protocol-registration.ts"))
      .toContain(".lvis-nsis-per-machine-v1");


    const cleanupScript = smoke.slice(
      smoke.indexOf("const WINDOWS_PROTOCOL_CLEANUP_SCRIPT"),
      smoke.indexOf("const TARGET_PLATFORM"),
    );
    expect(cleanupScript).toContain("$expectedCommand");
    expect(cleanupScript).toContain(
      "$expectedCommand = '\\\"' + $env:LVIS_PROTOCOL_OWNER_EXE + '\\\" \\\"%1\\\"'",
    );
    expect(cleanupScript).not.toContain("$launchExecutable");
    expect(cleanupScript).not.toContain("-match '\\s'");
    expect(cleanupScript).not.toContain(
      "owned lvis protocol cleanup left registry residue",
    );
    expect(cleanupScript).toContain("$expectedIcon");
    expect(cleanupScript).toContain("function Remove-RegistryValueIfEquals");
    expect(cleanupScript).toContain("$key.GetValueKind($name)");
    expect(cleanupScript).toContain("$commandKind = $commandKey.GetValueKind('')");
    expect(cleanupScript).toContain(
      "if ($null -eq $rootKey) { throw 'expected win-unpacked HKCU lvis protocol root is missing' }",
    );
    expect(cleanupScript).not.toContain(
      "if ($null -eq $rootKey) { return }",
    );

    expect(cleanupScript).toContain(
      "[Microsoft.Win32.RegistryValueKind]::String",
    );
    expect(cleanupScript).toContain(
      "Remove-RegistryValueIfEquals $commandPath '' $expectedCommand",
    );
    expect(cleanupScript).toContain("DefaultIcon' '' $expectedIcon");
    expect(cleanupScript).toContain(
      "Remove-RegistryValueIfEquals $rootPath 'URL Protocol' ''",
    );
    expect(cleanupScript).toContain(
      "Remove-RegistryValueIfEquals $rootPath '' 'URL:lvis'",
    );
    expect(cleanupScript).toContain(
      "[System.StringComparison]::OrdinalIgnoreCase",
    );
    expect(cleanupScript).toContain("$key.DeleteValue($name, $false)");
    expect(cleanupScript).toContain("Remove-EmptyRegistryKey");
    expect(cleanupScript).not.toContain("$expectedQuoted");
    expect(cleanupScript).not.toContain("$expectedUnquoted");
    expect(cleanupScript).not.toContain("StartsWith");
  });
  it("documents runtime package imports as dependencies, not devDependencies", () => {
    const agents = readRepoFile("AGENTS.md");

    expect(agents).toContain("unbundled runtime code");
    expect(agents).toContain("Renderer/UI-only");
    expect(agents).toContain("webpack/esbuild");
    expect(agents).toContain("`dependencies`");
    expect(agents).toContain("`devDependencies`");
    expect(agents).toContain("packaged-app smoke");
  });

  it("locks cross-cutting review and Markdown gate contracts", () => {
    const agents = readRepoFile("AGENTS.md");
    const claude = readRepoFile("CLAUDE.md");
    const contributing = readRepoFile("CONTRIBUTING.md");
    const pullRequestTemplate = readRepoFile(".github/pull_request_template.md");
    const clusterWorkflow = readRepoFile(".github/workflows/cluster-detector.yml");
    const clusterStatusOwners = readdirSync(resolve(root, ".github/workflows"))
      .filter((name) => /\.ya?ml$/.test(name))
      .filter((name) => {
        const source = readRepoFile(`.github/workflows/${name}`);
        return source.includes("statuses: write")
          || source.includes("STATUS_CONTEXT: Sensitive Area Cluster Check");
      })
      .sort();
    const clusterScope = readRepoFile("scripts/check-cluster-scope.mjs");
    const clusterAttestation = readRepoFile(
      "scripts/check-cluster-review-attestation.mjs",
    );
    const sensitivePathHelper = readRepoFile("scripts/check-cluster-sensitive-paths.mjs");

    expect(agents).toContain("## Cross-Cutting Review Gate");
    expect(agents).toContain("architect, critic, and security");
    expect(agents).toContain("current PR HEAD SHA");
    expect(agents).toContain("blocking findings");
    expect(agents).toContain("`cluster-review-passed`");
    expect(agents).toContain("consistent current-HEAD row and marker per role");
    expect(agents).toContain("Pull-request write is scoped only");
    expect(agents).toContain("status write is scoped only to the fixed");
    expect(agents).toContain("`Sensitive Area Cluster Check` context");
    expect(agents).toContain("sole workflow allowed");
    expect(agents).toContain("any PR edit");
    expect(pullRequestTemplate).toContain("PR edit");

    expect(clusterWorkflow).toContain("pull_request_target:");
    expect(clusterWorkflow).toContain("branches: [main]");
    expect(clusterWorkflow).toContain(
      "types: [opened, reopened, synchronize, edited, labeled, unlabeled]",
    );
    expect(clusterWorkflow).toContain("contents: read");
    expect(clusterWorkflow).toContain("pull-requests: write");
    expect(clusterWorkflow).toContain("statuses: write");
    expect(clusterWorkflow).not.toContain("pull-requests: read");
    expect(clusterWorkflow).not.toContain("issues: read");
    expect(clusterWorkflow).not.toContain("issues: write");
    expect(clusterWorkflow).toContain("PR-label DELETE returned 403");
    expect(clusterWorkflow).toContain("cancel-in-progress: false");
    expect(clusterWorkflow).not.toContain("cancel-in-progress: true");
    expect(clusterWorkflow).toContain("name: Trusted Cluster Policy Evaluation");
    expect(clusterWorkflow).not.toContain("    name: Sensitive Area Cluster Check");
    expect(clusterStatusOwners).toEqual(["cluster-detector.yml"]);
    expect(clusterWorkflow).toContain("STATUS_CONTEXT: Sensitive Area Cluster Check");
    expect(clusterWorkflow).toContain("-f state=pending");
    expect(clusterWorkflow).toContain(
      "issues/${PR_NUMBER}/labels/cluster-review-passed",
    );
    expect(clusterWorkflow).toContain("github.event.action == 'edited'");
    expect(clusterWorkflow).not.toContain("github.event.changes");

    const pendingIndex = clusterWorkflow.indexOf("Publish pending cluster status");
    const invalidationIndex = clusterWorkflow.indexOf(
      "Invalidate retained cluster review label",
    );
    const snapshotIndex = clusterWorkflow.indexOf("Capture live pull request snapshot");
    const checkoutIndex = clusterWorkflow.indexOf("Checkout trusted cluster policy");
    const finalizerIndex = clusterWorkflow.indexOf("Finalize cluster policy status");
    expect(invalidationIndex).toBeGreaterThan(pendingIndex);
    expect(snapshotIndex).toBeGreaterThan(invalidationIndex);
    expect(checkoutIndex).toBeGreaterThan(snapshotIndex);
    expect(finalizerIndex).toBeGreaterThan(checkoutIndex);
    expect(clusterWorkflow.match(/Finalize cluster policy status/g)).toHaveLength(1);
    expect(clusterWorkflow).not.toContain("Revalidate live pull request snapshot");
    expect(clusterWorkflow).not.toContain("Publish final cluster status");

    expect(clusterWorkflow).toContain(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7",
    );
    expect(clusterWorkflow).not.toContain("actions/checkout@v7");
    expect(clusterWorkflow).toContain("path: .cluster-policy");
    expect(clusterWorkflow).toContain("persist-credentials: false");
    expect(clusterWorkflow).toContain(
      "ref: ${{ steps.pr-snapshot.outputs.base_sha }}",
    );
    expect(clusterWorkflow).toContain("git -C .cluster-policy rev-parse HEAD");
    expect(clusterWorkflow).toContain(
      'if [ "$CHECKED_OUT_SHA" != "$EXPECTED_BASE_SHA" ]',
    );
    expect(clusterWorkflow).toContain(
      'if [ "$LIVE_HEAD_SHA" != "$EVENT_HEAD_SHA" ]',
    );

    const finalizer = clusterWorkflow.slice(finalizerIndex);
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
    expect(finalDigestIndex).toBeGreaterThan(finalSnapshotFetchIndex);
    expect(finalAttestationIndex).toBeGreaterThan(finalDigestIndex);
    expect(finalPostIndex).toBeGreaterThan(finalAttestationIndex);
    expect(finalizer).toContain("if: always()");
    expect(finalizer).toContain("PRIOR_JOB_STATUS: ${{ job.status }}");
    expect(finalizer).toContain("STATUS_STATE=failure");
    expect(finalizer).toContain("STATUS_STATE=success");
    expect(finalizer).toContain(
      'if ! gh api --method POST "repos/${REPO}/statuses/${HEAD_SHA}"',
    );
    expect(finalizer).toContain("exit 1");
    expect(clusterWorkflow).not.toContain("node scripts/");
    expect(clusterWorkflow).not.toContain("CLAUDE.md");
    expect(clusterWorkflow).not.toContain("|| true");
    expect(clusterWorkflow).toContain(
      ".cluster-policy/scripts/check-cluster-scope.mjs",
    );
    expect(clusterWorkflow).toContain(
      ".cluster-policy/scripts/check-cluster-review-attestation.mjs",
    );
    expect(clusterWorkflow).toContain("Enforce cluster review gate");
    expect(clusterWorkflow).not.toContain("steps.exempt-check.outputs.exempt");
    expect(clusterWorkflow).not.toContain("Post violation comment");
    expect(clusterScope).toContain(
      'import { hasSensitiveClusterPath } from "./check-cluster-sensitive-paths.mjs"',
    );
    expect(clusterScope).toContain("previous_filename");
    expect(clusterScope).toContain("github-previous-filename-required");
    expect(clusterScope).toContain("pull-request-page-duplicate");
    expect(clusterScope).toContain("pull-request-window-changed");
    expect(clusterScope).toContain("pull-request-files-incomplete");
    expect(clusterScope).toContain("pull-request-files-saturated");
    expect(clusterScope).toContain("pull-request-commits-saturated");
    expect(clusterScope).toContain("pull-request-pages-saturated");
    expect(clusterScope).toContain('state: "closed"');
    expect(clusterScope).not.toContain("--limit 100");
    expect(clusterAttestation).toContain("fresh-review-label-required");
    expect(clusterAttestation).toContain("isInsideMarkdownFence");
    expect(clusterAttestation).toContain("RAW_HTML_TOKEN_PATTERN");
    expect(clusterAttestation).toContain("hasRawHtmlTokenBefore");
    expect(clusterAttestation).toContain('candidate.suffix.includes("`")');
    expect(clusterAttestation).toContain(
      "hasRawHtmlTokenBefore(body, sectionStart)",
    );
    expect(clusterAttestation).toContain(
      "hasRawHtmlTokenBefore(body, tableIndex)",
    );
    expect(sensitivePathHelper).toContain("parseNulDelimitedGitPaths");
    expect(sensitivePathHelper).toContain(
      'return !path.startsWith(`${dir}/__tests__/`)',
    );

    for (const role of ["architect", "critic", "security"]) {
      expect(pullRequestTemplate).toContain(
        `<!-- cluster-review:${role}:<40-char-head-sha>:GO -->`,
      );
    }
    expect(pullRequestTemplate).toContain("## Cross-Cutting Review Gate");
    expect(pullRequestTemplate).toContain("Reviewed HEAD: `<40-char-head-sha>`");
    expect(pullRequestTemplate).toContain(
      "| Architect | `<HEAD_SHA>` | `GO` / `NO-GO` | None, or links/details |",
    );
    expect(pullRequestTemplate).toContain(
      "| Critic | `<HEAD_SHA>` | `GO` / `NO-GO` | None, or links/details |",
    );
    expect(pullRequestTemplate).toContain(
      "| Security | `<HEAD_SHA>` | `GO` / `NO-GO` | None, or links/details |",
    );
    expect(pullRequestTemplate).toContain("same current HEAD SHA and verdict");
    expect(pullRequestTemplate).toContain("exactly `None`");
    expect(pullRequestTemplate).toContain("only on a fresh");
    expect(pullRequestTemplate).toContain("removing and reapplying the label");
    expect(pullRequestTemplate).toContain("Blocking findings");
    expect(claude).toContain("[`AGENTS.md`](./AGENTS.md)");
    expect(claude).toContain("duplicates no");

    for (const guidance of [agents, contributing, pullRequestTemplate]) {
      expect(guidance).toContain("review-only Markdown");
      expect(guidance).toMatch(/runtime/i);
      expect(guidance).toMatch(/instruction/i);
      expect(guidance).toMatch(/workflow/i);
      expect(guidance).toMatch(/sensitive/i);
    }

    expect(agents).toContain("openFeatureNamespace");
    expect(agents).toContain("never hand-roll `mkdir`");
    expect(agents).toContain("`0o700` directory / `0o600`");
    expect(agents).toContain("mode bits alone are not encryption");
    expect(agents).toContain("src/shared/tool-timeout-policy.ts");
    expect(agents).toContain("TOOL_TIMEOUT_POLICY");
    expect(agents).toContain("runWithCeiling");
    expect(agents).toContain("AbortController");
    expect(agents).toContain("plus `Tool Governance` and `Security And Audit`");
    expect(agents).not.toContain("architecture section 6.3");
    expect(agents).toContain("staged default-on for `darwin`");
    expect(agents).toContain("opt-in for `linux`/`win32`");
    expect(agents).toContain("On `darwin`/`linux`, explicit `LVIS_SANDBOX_ENABLED=1`");
    expect(agents).toContain("default/settings mode may gracefully degrade");
    expect(agents).toContain("Windows always");
    expect(agents).toContain("degrades non-brickingly when unavailable");
    expect(agents).toContain("relaxation/effect-boundary coupling");
    expect(agents).toContain("No Fallback Code");
    expect(agents).toContain("plugin manifest field updates its schema and SDK");
    expect(agents).toContain("HostApi change bumps every plugin dependency pin");
    expect(agents).toContain("UI edits start with `grep` before editing");
    expect(agents).toContain("app shells `*Window`");
    expect(agents).toContain("bodies `*Content`, and modals `*Dialog`");
    expect(agents).toContain("marketplace API, `gh`, or local sources");
    expect(agents).toContain("not WebSearch. After three identical failures, change approach");
    expect(agents).toContain("sender/frame/origin checks");
    expect(agents).toContain("DLP handling");
    expect(agents).toContain("fail-closed defaults");
    expect(agents).toContain("active recipient's own permission and approval");
    expect(agents).toContain("visible role row and hidden marker");
    expect(agents).toContain("findings exactly `None`");
    expect(agents).toContain("Only a fresh application");
    expect(agents).toContain("any PR edit");
    expect(agents).toContain("Do not bypass hooks");
    expect(agents).toContain("Never push directly to `main`");
    expect(agents).toContain("same-PR field-addition");
    expect(agents).toContain("A new IPC channel is one coherent change");
    expect(agents).toContain("gh pr merge --merge");
    expect(agents).toContain("squash merge is not allowed");
    expect(agents).not.toContain("Markdown-only pushes");
    expect(contributing).not.toContain("Markdown-only pushes");
  });

  it("declares sonic-boom as a runtime dependency (log-file-sink imports it unbundled)", () => {
    // src/lib/log-file-sink.ts adds a top-level import from "sonic-boom" that
    // the packaged main process resolves directly from app.asar (unbundled
    // runtime code). The repository AGENTS.md contract requires it in
    // `dependencies`, NOT `devDependencies` — otherwise electron-builder prunes
    // it and the installed app crashes on first log write with
    // ERR_MODULE_NOT_FOUND (the PR #684 regression class). Assert the dependency
    // declaration so a future prune-to-devDep is caught here.
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies?.["sonic-boom"]).toBeDefined();
    expect(packageJson.devDependencies?.["sonic-boom"]).toBeUndefined();

    // And the import is actually present in the unbundled runtime source, so
    // this guard tracks a real import rather than an orphaned dependency.
    const sinkSource = readRepoFile("src/lib/log-file-sink.ts");
    expect(sinkSource).toContain('from "sonic-boom"');
  });

  it("keeps fast preview installer mode separate from size-optimized release artifacts", () => {
    const packageJson = readRepoFile("package.json");
    const buildInstallers = readRepoFile("scripts/build-installers.mjs");
    const releaseChecklist = readRepoFile("docs/references/production-release-checklist.md");

    expect(packageJson).toContain('"dist:fast"');
    expect(packageJson).toContain('"dist:mac:fast"');
    expect(packageJson).toContain('"dist:win:fast"');

    expect(buildInstallers).toContain("--fast");
    expect(buildInstallers).toContain("release-fast");
    expect(buildInstallers).toContain("-c.compression=store");
    expect(buildInstallers).toContain("-c.npmRebuild=false");
    expect(buildInstallers).toContain("cannot be combined with --publish");

    expect(releaseChecklist).toContain("Fast preview mode is only for quick QA links");
    expect(releaseChecklist).toContain("Keep normal `dist:*` / `release`");
    expect(releaseChecklist).toContain("public release assets");
    expect(releaseChecklist).toContain("DMG 106M / ZIP 103M");
    expect(releaseChecklist).toContain("DMG 227M / ZIP 226M");
  });

  it("fails packaging when the platform uv payload or uv license notice is missing", () => {
    const buildInstallers = readRepoFile("scripts/build-installers.mjs");
    const afterPack = readRepoFile("scripts/electron-after-pack.cjs");
    const packageFootprint = readRepoFile("scripts/check-package-footprint.mjs");
    const runtimeAssets = readRepoFile("scripts/packaged-runtime-assets.mjs");

    expect(runtimeAssets).toContain("HOST_PACKAGED_RUNTIME_ASSETS");
    expect(runtimeAssets).toContain("PLUGIN_MANAGED_RUNTIME_ASSETS");
    expect(runtimeAssets).toContain("resources/uv-runtime");
    expect(runtimeAssets).toContain("resources/licenses/uv");
    expect(runtimeAssets).toContain("better-sqlite3-native-binding");
    expect(runtimeAssets).toContain("python-wheelhouse");
    expect(buildInstallers).toContain("hostRuntimeAssetSummary(target)");
    expect(buildInstallers).toContain("required runtime assets");
    expect(buildInstallers).toContain("checkPackageFootprint(target, fast)");
    expect(buildInstallers).toContain("expected exactly one packaged app.asar");
    expect(buildInstallers).toContain("assertUvRuntimePayload(target)");
    expect(buildInstallers).toContain("staged uv runtime must contain only");
    expect(buildInstallers).toContain("compressed uv archive missing from staged runtime");
    expect(buildInstallers).toContain("staged uv binary SHA mismatch");
    expect(afterPack).toContain("assertBundledUvResource(context)");
    expect(afterPack).toContain("packaged uv resource must contain exactly one target");
    expect(afterPack).toContain("packaged uv binary SHA mismatch");
    expect(afterPack).toContain("uv license notice missing");
    expect(packageFootprint).toContain("packaged uv binary SHA mismatch");
    expect(packageFootprint).toContain("uv license notice missing");
  });

  it("keeps packaged Windows smoke launch flags on the same launcher SOT", () => {
    const smokePackagedApp = readRepoFile("scripts/smoke-packaged-app.mjs");
    const smokeWindowsNsis = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");
    const electronLaunchOptions = readRepoFile("scripts/lib/electron-launch-options.mjs");

    expect(smokePackagedApp).toContain("prepareElectronLaunchEnv");
    expect(smokePackagedApp).toContain("prepareElectronLaunchArgs");
    expect(smokePackagedApp).not.toContain('from "./electron-flags.mjs";');
    expect(smokeWindowsNsis).toContain("prepareElectronLaunchEnv");
    expect(smokeWindowsNsis).toContain("prepareElectronLaunchArgs");
    expect(smokeWindowsNsis).not.toContain("const WINDOWS_SAFE_GPU_FLAGS = [");
    expect(smokeWindowsNsis).not.toContain('const SANDBOX_BYPASS_FLAG = "--no-sandbox";');
    expect(electronLaunchOptions).toContain("prepareElectronLaunchEnv");
    expect(electronLaunchOptions).toContain("prepareElectronLaunchArgs");
    expect(electronLaunchOptions).toContain("SANDBOX_BYPASS_FLAG");
  });

  it("keeps #1444/#1446 packaged smoke gates wired", () => {
    const afterPack = readRepoFile("scripts/electron-after-pack.cjs");
    const smokePackagedApp = readRepoFile("scripts/smoke-packaged-app.mjs");
    const packageFootprint = readRepoFile("scripts/check-package-footprint.mjs");

    expect(afterPack).toContain("assertNodePtyBinary(context)");
    expect(afterPack).toContain("conpty.node");
    expect(afterPack).toContain("conpty_console_list.node");
    expect(afterPack).toContain("winpty.dll");
    expect(afterPack).toContain("winpty-agent.exe");
    // node-pty builds `spawn-helper` only on macOS (binding.gyp `OS=="mac"`), and
    // only macOS uses it at runtime (`pty.cc` gates helperPath on `__APPLE__`).
    // Scoping this assertion to any non-Windows platform fails every Linux
    // installer build at afterPack — it broke the v0.4.5/v0.4.6 tag builds.
    expect(afterPack).toContain('if (platform === "darwin") {');
    expect(afterPack).toContain("spawn-helper");
    expect(smokePackagedApp).toContain("assertPackagedFootprint(target, executable)");
    expect(smokePackagedApp).toContain("check-package-footprint.mjs");
    expect(smokePackagedApp).toContain("app.asar footprint passed");
    expect(packageFootprint).toContain("mermaid\\.[0-9a-f]{8}\\.js");
    expect(packageFootprint).toContain("required lazy renderer chunks missing from app.asar");
  });

  it("packages only the default Electron locale in the desktop shell", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      build?: { electronLanguages?: string[] };
    };
    const packageFootprint = readRepoFile("scripts/check-package-footprint.mjs");

    expect(packageJson.build?.electronLanguages).toEqual(["en-US"]);
    expect(packageFootprint).toContain('DEFAULT_PACKAGED_ELECTRON_LANGUAGES = Object.freeze(["en-US"])');
    expect(packageFootprint).toContain("desktop app must package only the default Electron language");
    expect(packageFootprint).toContain("ship UI languages as marketplace language packs");
    expect(packageFootprint).not.toContain('["en-US", "ko"]');
    expect(packageFootprint).not.toContain('"ko.pak"');
    expect(packageFootprint).not.toContain('"ko.lproj"');
  });

  it("derives packaged runtime script footprint from the build asset SOT", () => {
    const packageFootprint = readRepoFile("scripts/check-package-footprint.mjs");

    expect(packageFootprint).toContain('import { resolveBuildAssets } from "./lib/build-assets.mjs";');
    expect(packageFootprint).toContain('resolveBuildAssets(root, "runtime-script")');
    expect(packageFootprint).not.toContain('"/dist/scripts/electron-flags.mjs",');
    expect(packageFootprint).not.toContain('"/dist/scripts/uv-targets.mjs",');
  });

  it("keeps electron-builder host runtime resources aligned with the runtime asset inventory", async () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      build?: { extraResources?: Array<{ from?: string; to?: string }> };
    };
    const runtimeAssets = await import("../../scripts/packaged-runtime-assets.mjs");
    const extraResources = packageJson.build?.extraResources ?? [];
    const hostResources = runtimeAssets.HOST_PACKAGED_RUNTIME_ASSETS.flatMap(
      (asset: {
        stagedBy?: string;
        packageResource?: { from: string; to: string };
        licenseResource?: { from: string; to: string };
      }) =>
        asset.stagedBy === "electron-builder native rebuild"
          ? []
          : [asset.packageResource, asset.licenseResource].filter(Boolean),
    );

    for (const resource of hostResources) {
      expect(extraResources).toContainEqual({
        from: resource.from,
        to: resource.to,
      });
    }
  });
});
