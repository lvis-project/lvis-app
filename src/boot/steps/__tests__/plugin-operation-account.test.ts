import { describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "../../../plugins/types.js";
import { resolvePluginOperationAccountHash } from "../plugin-operation-account.js";

function resolver(accountHash: string | undefined) {
  return {
    getPluginOperationAccountHash: vi.fn(() => accountHash),
  };
}

describe("resolvePluginOperationAccountHash", () => {
  it("uses the authenticated runtime account binding when available", () => {
    const runtime = resolver("authenticated-account");

    expect(
      resolvePluginOperationAccountHash(
        runtime,
        { auth: {} } as PluginManifest,
        "ep-api",
        "generation-a",
      ),
    ).toBe("authenticated-account");
  });

  it("requires a fresh account binding when the manifest declares auth", () => {
    const runtime = resolver(undefined);

    expect(
      resolvePluginOperationAccountHash(
        runtime,
        { auth: {} } as PluginManifest,
        "ep-api",
        "generation-a",
      ),
    ).toBeUndefined();
  });

  it("derives a stable generation-bound anonymous principal only for authless plugins", () => {
    const runtime = resolver(undefined);
    const manifest = {} as PluginManifest;
    const first = resolvePluginOperationAccountHash(
      runtime,
      manifest,
      "ep-api",
      "generation-a",
    );

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(
      resolvePluginOperationAccountHash(
        runtime,
        manifest,
        "ep-api",
        "generation-a",
      ),
    ).toBe(first);
    expect(
      resolvePluginOperationAccountHash(
        runtime,
        manifest,
        "ep-api",
        "generation-b",
      ),
    ).not.toBe(first);
    expect(
      resolvePluginOperationAccountHash(
        runtime,
        manifest,
        "other-plugin",
        "generation-a",
      ),
    ).not.toBe(first);
  });
});
