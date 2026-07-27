import { describe, expect, it } from "vitest";
import { pluginArtifactGenerationId } from "../plugin-artifact-identity.js";

const manifestRaw = JSON.stringify({
  id: "ep-api",
  version: "1.0.0",
  entry: "dist/index.js",
});
const primaryFileHash = "a".repeat(64);
const secondaryFileHash = "b".repeat(64);

function receiptRaw(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    pluginId: "ep-api",
    version: "1.0.0",
    installSource: "marketplace",
    artifactSha256: "c".repeat(64),
    signerKeyId: "marketplace-v1",
    installedAt: "2026-07-27T00:00:00.000Z",
    files: [
      { path: "dist/index.js", sha256: primaryFileHash },
      { path: "plugin.json", sha256: secondaryFileHash },
    ],
    ...overrides,
  });
}

describe("plugin artifact generation identity", () => {
  it("restores identity when only local installation metadata changes", () => {
    const initial = pluginArtifactGenerationId(manifestRaw, receiptRaw());
    const reinstalled = pluginArtifactGenerationId(manifestRaw, receiptRaw({
      installedAt: "2026-07-27T00:05:00.000Z",
      files: [
        { path: "plugin.json", sha256: secondaryFileHash },
        { path: "dist/index.js", sha256: primaryFileHash },
      ],
    }));

    expect(reinstalled).toBe(initial);
  });

  it("keeps every security-relevant receipt field in the identity", () => {
    const initial = pluginArtifactGenerationId(manifestRaw, receiptRaw());
    const changedReceipts = [
      receiptRaw({ schemaVersion: 1 }),
      receiptRaw({ pluginId: "other-plugin" }),
      receiptRaw({ version: "2.0.0" }),
      receiptRaw({ installSource: "local-dev", artifactSha256: null, signerKeyId: null }),
      receiptRaw({ artifactSha256: "d".repeat(64) }),
      receiptRaw({ signerKeyId: "marketplace-v2" }),
      receiptRaw({
        files: [
          { path: "dist/index.js", sha256: "e".repeat(64) },
          { path: "plugin.json", sha256: secondaryFileHash },
        ],
      }),
    ];

    for (const changedReceipt of changedReceipts) {
      expect(pluginArtifactGenerationId(manifestRaw, changedReceipt)).not.toBe(initial);
    }
    expect(pluginArtifactGenerationId(
      JSON.stringify({ id: "ep-api", version: "1.0.0", entry: "dist/changed.js" }),
      receiptRaw(),
    )).not.toBe(initial);
  });
});
