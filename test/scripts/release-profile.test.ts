import { readFileSync } from "node:fs";
import { resolveReleaseProfile } from "../../scripts/release-profile.mjs";
import { describe, expect, it } from "vitest";

const actualPackage = JSON.parse(readFileSync("package.json", "utf8"));
const SOURCE_SHA = "a".repeat(40);

function publicManifest(signing = "unsigned") {
  return {
    version: "9.8.7",
    lvisRelease: {
      tagDistribution: "public",
      signing,
    },
  };
}

describe("immutable public release profile", () => {
  it("pins the current package tag to the only supported unsigned public profile", () => {
    const profile = resolveReleaseProfile({
      eventName: "push",
      refName: "v" + actualPackage.version,
      sourceSha: SOURCE_SHA,
      packageJson: actualPackage,
    });

    expect(actualPackage.lvisRelease).toEqual({
      tagDistribution: "public",
      signing: "unsigned",
    });
    expect(profile).toEqual({
      distributionChannel: "public",
      signingMode: "unsigned",
    });
  });

  it("keeps workflow-dispatch builds as secret-free internal candidates", () => {
    expect(
      resolveReleaseProfile({
        eventName: "workflow_dispatch",
        refName: "main",
        sourceSha: undefined,
        packageJson: {},
      }),
    ).toEqual({
      distributionChannel: "internal",
      signingMode: "internal-candidate",
    });
  });

  it.each([
    [{ version: "9.8.7" }, "v9.8.7", SOURCE_SHA],
    [publicManifest("signed-notarized"), "v9.8.7", SOURCE_SHA],
    [publicManifest(), "v9.8.8", SOURCE_SHA],
    [publicManifest(), "release-9.8.7", SOURCE_SHA],
    [publicManifest(), "v9.8.7", "not-a-commit"],
  ])("fails closed for invalid public tag metadata", (packageJson, refName, sourceSha) => {
    expect(() =>
      resolveReleaseProfile({
        eventName: "push",
        refName,
        sourceSha,
        packageJson,
      }),
    ).toThrow("[release-profile-invalid]");
  });
});
