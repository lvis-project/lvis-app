/**
 * #1498 build-guard regression test (critic MINOR-2).
 *
 * The public/external distribution channel embedded-demo-key ban lives in
 * `scripts/build-main-esbuild.mjs` (`assertNoPublicEmbed`). It is a
 * security-load-bearing control — embedding the demo activation key into a
 * build destined for an external audience collapses the codec's 2-factor
 * delivery to 1-factor outside the internal-network boundary the threat model
 * assumes — but until now it was verified only by hand. This test spawns the
 * real build script with `LVIS_DISTRIBUTION_CHANNEL=public` plus an embed
 * source and asserts the guard aborts with exit code 1.
 *
 * FAIL path only, by design: the guard runs (line ~58) BEFORE the heavy
 * esbuild bundle, so this exits in milliseconds. Exercising the PASS path
 * would run the full main-process bundle (slow) for no additional coverage of
 * the guard itself.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const buildScript = resolve(repoRoot, "scripts", "build-main-esbuild.mjs");
const installersWorkflow = resolve(repoRoot, ".github", "workflows", "build-installers.yml");
const releaseProfileScript = resolve(repoRoot, "scripts", "release-profile.mjs");
const unsignedReleaseBody = resolve(repoRoot, ".github", "release-bodies", "public-unsigned.md");

/** A structurally valid activation wire string (guard checks the shape, not decryptability). */
const VALID_EMBED = "LVIS-DEMO:v1:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo";

function runBuildGuard(env: Record<string, string>): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [buildScript], {
    cwd: repoRoot,
    encoding: "utf8",
    // Inherit PATH etc.; overlay only the channel/embed signals under test.
    env: { ...process.env, ...env },
    // The guard aborts fast; cap so a regression that reaches the real bundle
    // does not hang the suite.
    timeout: 60_000,
  });
}

describe("build-main-esbuild public-channel embed guard (#1498)", () => {
  it("aborts with exit 1 when LVIS_DISTRIBUTION_CHANNEL=public carries an embedded key via env", () => {
    const result = runBuildGuard({
      LVIS_DISTRIBUTION_CHANNEL: "public",
      LVIS_EMBED_DEMO_ACTIVATION: VALID_EMBED,
    });
    expect(result.status).toBe(1);
    // Actionable, fail-loud message (not a silent strip of the embed).
    expect(result.stderr).toContain("LVIS_DISTRIBUTION_CHANNEL=public");
    expect(result.stderr).toContain("forbids an embedded demo");
    // The guard must fire BEFORE the embed is ever resolved/printed or the
    // heavy esbuild bundle runs — proving it is a pre-build gate.
    expect(result.stdout ?? "").not.toContain("embedded activation key: present");
    expect(result.stdout ?? "").not.toContain("OK ->");
  });

  it("pins public tags to a secret-free unsigned workflow and disclosure", () => {
    const workflow = readFileSync(installersWorkflow, "utf8");
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    const unsignedBody = readFileSync(unsignedReleaseBody, "utf8");
    const installersStart = workflow.indexOf("  installers:");
    const publishStart = workflow.indexOf("  publish-release:");
    const installersJob = workflow.slice(installersStart, publishStart);
    const dmgContents = packageJson.build.dmg.contents as Array<{ path?: string }>;

    expect(packageJson.lvisRelease).toEqual({
      tagDistribution: "public",
      signing: "unsigned",
    });
    expect(existsSync(releaseProfileScript)).toBe(true);
    expect(workflow).toContain("release-profile:");
    expect(workflow).toContain("needs: release-profile");
    expect(workflow).toContain("needs: [release-profile, installers]");
    expect(workflow).toContain("node scripts/release-profile.mjs");
    expect(workflow).toContain("--source-sha \"${{ github.sha }}\"");
    expect(workflow.match(/ref: \$\{\{ github\.sha \}\}/g)).toHaveLength(3);
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(3);
    expect(workflow).toContain("Checkout HEAD does not equal immutable event source SHA");
    expect(workflow).toContain("github.ref_protected");
    expect(workflow).toContain("Public tag releases require an active immutable v* tag ruleset");
    expect(workflow).toContain("Verify protected annotated tag still resolves to event SHA");
    expect(workflow).toContain("/git/ref/tags/${EXPECTED_TAG}");
    expect(workflow).toContain("/git/tags/${tag_object_sha}");
    expect(workflow).toContain("Annotated tag does not resolve to the immutable event source SHA");
    expect(installersJob).toContain("contents: read");
    expect(installersJob).not.toContain("contents: write");
    expect(installersJob).not.toContain("GH_TOKEN:");
    expect(installersJob).not.toContain("secrets.LVIS_EMBED_DEMO_ACTIVATION");
    expect(installersJob).not.toContain("secrets.CSC_LINK");
    expect(installersJob).toContain(
      "LVIS_DISTRIBUTION_CHANNEL: ${{ github.event_name == 'push' && 'public' || 'internal' }}",
    );
    expect(installersJob).toContain('LVIS_EMBED_DEMO_ACTIVATION: ""');
    expect(installersJob).toContain('if [ "${{ github.event_name }}" = "push" ]; then');
    expect(installersJob).toContain('args+=("--skip-code-sign")');
    expect(workflow).toContain("body_path: .github/release-bodies/public-unsigned.md");
    expect(workflow).toContain("target_commitish: ${{ github.sha }}");
    expect(workflow).not.toContain("steps.release-profile.outputs");
    expect(workflow).not.toContain("public-signed-notarized.md");

    expect(unsignedBody).toContain("## Important: unsigned and not notarized");
    expect(unsignedBody).toContain("Windows:** SmartScreen");
    expect(unsignedBody).toContain("macOS:** Gatekeeper");
    expect(unsignedBody).toContain("Required operator record before publish");
    expect(dmgContents).toHaveLength(2);
    expect(dmgContents.map((entry) => entry.path).filter(Boolean)).toEqual(["/Applications"]);
  });
});
