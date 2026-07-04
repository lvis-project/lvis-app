/**
 * permissions-store unit tests — readPermissionsFile parse/error handling
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  open: vi.fn(async () => ({
    writeFile: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  })),
  readFile: readFileMock,
}));

import { readPermissionsFile } from "../permissions-store.js";

describe("readPermissionsFile", () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it("returns null for empty or whitespace-only content", async () => {
    readFileMock.mockResolvedValue("   \n\t ");

    await expect(readPermissionsFile("/tmp/permissions.json")).resolves.toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    readFileMock.mockResolvedValue("{ invalid-json");

    await expect(readPermissionsFile("/tmp/permissions.json")).resolves.toBeNull();
  });

  it("returns null for ENOENT", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    readFileMock.mockRejectedValue(enoent);

    await expect(readPermissionsFile("/tmp/permissions.json")).resolves.toBeNull();
  });

  it("returns parsed object for valid file", async () => {
    const valid = {
      version: 1,
      rules: [],
      mode: "default",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    readFileMock.mockResolvedValue(JSON.stringify(valid));

    await expect(readPermissionsFile("/tmp/permissions.json")).resolves.toEqual(valid);
  });

  it("preserves P2 grant tier on a version:1 file (additive field, no version bump)", async () => {
    // P2 keeps version:1 — `tier` is an additive optional field. A v1 file with
    // tiered allow rules must load unchanged (bumping the version would make
    // readPermissionsFile reject it and lose every saved rule).
    const tiered = {
      version: 1,
      rules: [
        { pattern: "reader_tool", action: "allow", tier: "read" },
        { pattern: "writer_tool", action: "allow", tier: "write" },
        { pattern: "legacy_tool", action: "allow" },
      ],
      mode: "default",
      updatedAt: "2026-07-04T00:00:00.000Z",
    };
    readFileMock.mockResolvedValue(JSON.stringify(tiered));

    await expect(readPermissionsFile("/tmp/permissions.json")).resolves.toEqual(tiered);
  });
});
