import { describe, expect, it } from "vitest";
import type { ManifestLoadPlan, ManifestSnapshot } from "../index.js";

describe("PluginRuntime public type contract", () => {
  it("keeps manifest planning types available from the runtime index", () => {
    const plan = {
      manifestPath: "/plugins/example/plugin.json",
      enabled: true,
    } satisfies ManifestLoadPlan;
    const snapshot = {
      manifest: { id: "example" },
    } as unknown as ManifestSnapshot;

    expect(plan.manifestPath).toContain("plugin.json");
    expect(snapshot.manifest.id).toBe("example");
  });
});
