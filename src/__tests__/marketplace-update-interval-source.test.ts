import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("marketplace update-check interval source", () => {
  it("defaults plugin marketplace update checks to ten minutes", () => {
    const postBoot = readFileSync("src/boot/steps/post-boot.ts", "utf-8").replace(/\r\n/g, "\n");
    const settings = readFileSync("src/data/settings-store.ts", "utf-8").replace(/\r\n/g, "\n");

    expect(postBoot).toContain("const DEFAULT_UPDATE_INTERVAL_MS = 10 * 60 * 1000");
    expect(postBoot).toContain("default 10m");
    expect(settings).toContain("Default 10 minutes (600_000 ms)");
  });
});
