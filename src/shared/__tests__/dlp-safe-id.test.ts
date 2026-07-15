import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { maskSensitiveData } from "../dlp.js";
import { createDlpSafeUuid } from "../dlp-safe-id.js";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_UUID = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const UNSAFE_UUID = "12345678-1234-4234-8234-123456789abc";
const PREFIX_BOUNDARY_UUID = "56784123-8128-4abc-8def-abcdefabcdef";

describe("createDlpSafeUuid", () => {
  it("creates unique UUIDv4 values whose complete bare and prefixed forms pass DLP", () => {
    const bare = Array.from({ length: 64 }, () => createDlpSafeUuid());
    const prefixed = Array.from({ length: 64 }, () => createDlpSafeUuid("sub-abcd1234"));

    expect(new Set([...bare, ...prefixed]).size).toBe(128);
    for (const id of bare) {
      expect(id).toMatch(UUID_V4_PATTERN);
      expect(maskSensitiveData(id).detections).toEqual([]);
    }
    for (const id of prefixed) {
      expect(id).toMatch(/^sub-abcd1234-/);
      expect(id.slice("sub-abcd1234-".length)).toMatch(UUID_V4_PATTERN);
      expect(maskSensitiveData(id).detections).toEqual([]);
    }
  });

  it("retries a credit-card-shaped UUID instead of returning a masked identifier", () => {
    const makeUuid = vi.fn()
      .mockReturnValueOnce(UNSAFE_UUID)
      .mockReturnValueOnce(SAFE_UUID);

    expect(createDlpSafeUuid("", makeUuid)).toBe(SAFE_UUID);
    expect(makeUuid).toHaveBeenCalledTimes(2);
  });

  it("retries when only the final prefix boundary creates a DLP match", () => {
    expect(maskSensitiveData(PREFIX_BOUNDARY_UUID).detections).toEqual([]);
    expect(maskSensitiveData(`sub-abcd1234-${PREFIX_BOUNDARY_UUID}`).detections)
      .not.toEqual([]);
    const makeUuid = vi.fn()
      .mockReturnValueOnce(PREFIX_BOUNDARY_UUID)
      .mockReturnValueOnce(SAFE_UUID);

    expect(createDlpSafeUuid("sub-abcd1234", makeUuid))
      .toBe(`sub-abcd1234-${SAFE_UUID}`);
    expect(makeUuid).toHaveBeenCalledTimes(2);
  });

  it("fails closed after the bounded retry ceiling", () => {
    const makeUuid = vi.fn(() => UNSAFE_UUID);
    expect(() => createDlpSafeUuid("", makeUuid))
      .toThrow("[dlp-safe-uuid-exhausted]");
    expect(makeUuid).toHaveBeenCalledTimes(8);
  });

  it("rejects a sensitive prefix before generating an identifier", () => {
    const makeUuid = vi.fn(() => SAFE_UUID);
    expect(() => createDlpSafeUuid("12345678-1234-4234", makeUuid))
      .toThrow("[dlp-safe-uuid-prefix-rejected]");
    expect(makeUuid).not.toHaveBeenCalled();
  });

  it("locks every cross-agent UUID generation site to the shared safe generator", () => {
    const productionSources = [
      "../../api/a2a-subagent-handler.ts",
      "../../engine/conversation-loop.ts",
      "../../engine/subagent-runner.ts",
      "../../engine/turn/session.ts",
      "../../ipc/domains/chat.ts",
      "../../tools/agent-send.ts",
      "../../tools/agent-spawn.ts",
    ];
    for (const relativePath of productionSources) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source, relativePath).toContain("createDlpSafeUuid");
      expect(source, relativePath).not.toMatch(/\b(?:crypto\.)?randomUUID\s*\(/);
    }
  });
});
