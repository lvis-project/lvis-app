import { describe, it, expect } from "vitest";
import { resolveDependencies, installedCapabilities } from "../dependency-resolver.js";
import type { PluginManifest } from "../types.js";

function makeManifest(caps: string[]): PluginManifest {
  return {
    id: "test-plugin",
    name: "Test",
    version: "1.0.0",
    entry: "dist/index.js",
    tools: [],
    description: "Test fixture.",
    capabilities: caps,
  };
}

describe("installedCapabilities", () => {
  it("returns empty set for no manifests", () => {
    expect(installedCapabilities([])).toEqual(new Set());
  });

  it("collects capabilities from all manifests", () => {
    const caps = installedCapabilities([
      makeManifest(["meeting-recorder"]),
      makeManifest(["knowledge-index", "mail-source"]),
    ]);
    expect(caps).toEqual(new Set(["meeting-recorder", "knowledge-index", "mail-source"]));
  });

  it("ignores manifests without capabilities field", () => {
    const m = { ...makeManifest([]) };
    delete (m as Partial<PluginManifest>).capabilities;
    expect(installedCapabilities([m as PluginManifest])).toEqual(new Set());
  });
});

describe("resolveDependencies", () => {
  it("ok when required is empty", () => {
    const result = resolveDependencies([], []);
    expect(result.ok).toBe(true);
  });

  it("ok when all required capabilities are satisfied", () => {
    const result = resolveDependencies(
      ["meeting-recorder"],
      [makeManifest(["meeting-recorder", "knowledge-index"])],
    );
    expect(result.ok).toBe(true);
  });

  it("returns missing when capability is absent", () => {
    const result = resolveDependencies(
      ["knowledge-index"],
      [makeManifest(["meeting-recorder"])],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["knowledge-index"]);
    }
  });

  it("returns all missing capabilities, not just the first", () => {
    const result = resolveDependencies(
      ["cap-a", "cap-b", "cap-c"],
      [makeManifest(["cap-b"])],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["cap-a", "cap-c"]);
    }
  });

  it("ok when installed list is empty but required is also empty", () => {
    const result = resolveDependencies([], []);
    expect(result.ok).toBe(true);
  });
});
