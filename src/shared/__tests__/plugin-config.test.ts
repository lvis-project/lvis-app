import { describe, expect, it } from "vitest";
import {
  sanitizePluginConfig,
  sanitizePluginConfigKey,
  sanitizePluginConfigPluginId,
} from "../plugin-config.js";

describe("plugin-config sanitizers", () => {
  it("rejects wildcard and reserved plugin ids", () => {
    expect(() => sanitizePluginConfigPluginId("*")).toThrow(/reserved/i);
    expect(() => sanitizePluginConfigPluginId("__proto__")).toThrow(/reserved/i);
  });

  it("rejects dangerous keys recursively", () => {
    expect(() =>
      sanitizePluginConfig(JSON.parse("{\"safe\":{\"__proto__\":\"boom\"}}")),
    ).toThrow(/reserved/i);
  });

  it("keeps JSON-compatible values and trims keys", () => {
    expect(
      sanitizePluginConfig({
        " apiKey ": "value",
        nested: { enabled: true, retries: 2 },
        items: [1, "two", false, null],
      }),
    ).toEqual({
      apiKey: "value",
      nested: { enabled: true, retries: 2 },
      items: [1, "two", false, null],
    });
  });

  it("rejects empty keys", () => {
    expect(() => sanitizePluginConfigKey("   ")).toThrow(/empty/i);
  });
});
