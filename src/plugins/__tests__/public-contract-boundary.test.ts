import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_EVERYTHING_REGEX,
  HOST_BROWSER_EXTERNAL_MODULES,
  HOST_EXTERNAL_MODULES,
} from "../public-contract.js";

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
        new RegExp(`^export (?:interface|type|class|const|enum) ${declaration}\\b`,
          "m",
        ),
      );
    }
  });

  it("keeps public JSDoc in the Host source and re-exports it through types.ts", async () => {
    const [contract, barrel] = await Promise.all([
      readFile(PUBLIC_CONTRACT_URL, "utf8"),
      readFile(TYPES_BARREL_URL, "utf8"),
    ]);

    expect(contract).toContain("`tools` is the only callable surface.");
    expect(contract).toContain("Pure MCP `Tool` objects");
    expect(contract).not.toMatch(/\bkeywords\??:/);
    expect(contract).not.toContain("registerKeywords");
    expect(barrel).toContain('export * from "./public-contract.js";');
  });

  it("owns the plugin build-policy ABI mirrored by the SDK", () => {
    expect(HOST_EXTERNAL_MODULES).toEqual(["electron"]);
    expect(HOST_BROWSER_EXTERNAL_MODULES).toEqual(["react", "react-dom"]);
    expect(BUNDLE_EVERYTHING_REGEX.source).toBe(".*");
  });
});
