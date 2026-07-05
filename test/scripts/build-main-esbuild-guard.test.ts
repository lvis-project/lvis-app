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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const buildScript = resolve(repoRoot, "scripts", "build-main-esbuild.mjs");

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
});
