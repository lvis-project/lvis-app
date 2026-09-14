import { describe, expect, it } from "vitest";
import { normalizeToolOutputArtifactInfo, type ToolOutputArtifactInfo } from "../tool-output-artifact.js";

const COMPLETE: ToolOutputArtifactInfo = {
  version: 1, captureId: "8a001f65-0551-4cec-9152-40c5232915dc", status: "complete",
  capturedBytes: 4, observedBytes: 4, capturedChars: 2, sha256: "a".repeat(64),
};

describe("tool output artifact reference", () => {
  it("copies a complete reference without sharing the persisted object", () => {
    const result = normalizeToolOutputArtifactInfo(COMPLETE);
    expect(result).toEqual(COMPLETE);
    expect(result).not.toBe(COMPLETE);
  });

  it("keeps partial and unavailable provenance explicit", () => {
    expect(normalizeToolOutputArtifactInfo({ ...COMPLETE, status: "partial", reason: "interrupted" }))
      .toMatchObject({ status: "partial", reason: "interrupted" });
    expect(normalizeToolOutputArtifactInfo({
      version: 1, captureId: COMPLETE.captureId, status: "unavailable", reason: "session-limit",
      capturedBytes: 0, capturedChars: 0, observedBytes: 123,
    })).toMatchObject({ status: "unavailable", observedBytes: 123 });
  });

  it.each([
    { path: "/arbitrary/path" }, { version: 2 }, { captureId: "../capture" },
    { status: "partial" }, { reason: "interrupted" }, { capturedBytes: 5_000_001 },
    { observedBytes: 3 }, { observedBytes: Infinity }, { capturedChars: 5 },
    { capturedChars: 1.5 }, { sha256: "invalid" }, { status: "unavailable", reason: "write-failed" },
  ])("rejects malformed or inconsistent fields %j", (change) => {
    expect(normalizeToolOutputArtifactInfo({ ...COMPLETE, ...change })).toBeNull();
  });

  it("rejects getters that throw and non-record values", () => {
    expect(normalizeToolOutputArtifactInfo({ get version() { throw new Error("invalid"); } })).toBeNull();
    for (const value of [null, [], "capture", undefined]) expect(normalizeToolOutputArtifactInfo(value)).toBeNull();
  });
});
