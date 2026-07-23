import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const PUBLIC_CONTRACT_URL = new URL("../public-contract.ts", import.meta.url);
const TYPES_BARREL_URL = new URL("../types.ts", import.meta.url);

describe("Host-owned public plugin contract boundary", () => {
  it("keeps the SDK source self-contained and excludes Host-private DTOs", async () => {
    const source = await readFile(PUBLIC_CONTRACT_URL, "utf8");

    expect(source).not.toMatch(/^import\s/m);
    for (const declaration of [
      "PluginRegistryEntryInstallSource",
      "PluginRegistryEntry",
      "PluginRegistry",
      "PluginMarketplaceItem",
    ]) {
      expect(source).not.toMatch(
        new RegExp(`^export (?:interface|type|class|const|enum) ${declaration}\\b`, "m"),
      );
    }
  });

  it("keeps public JSDoc in the Host source and re-exports it through types.ts", async () => {
    const [contract, barrel] = await Promise.all([
      readFile(PUBLIC_CONTRACT_URL, "utf8"),
      readFile(TYPES_BARREL_URL, "utf8"),
    ]);

    expect(contract).toContain("Keyword-to-tool preload entries.");
    expect(contract).toContain("matching never invokes");
    expect(contract).toContain("@deprecated Owner: `lvis-app` plugin runtime.");
    expect(contract).toContain("no active manifest declares `keywords`");
    expect(barrel).toContain('export * from "./public-contract.js";');
  });
});
