/**
 * AppContainerRunner — PR-A3 unit tests (detect-only).
 *
 * Issue: #691 PR-A3
 *
 * Tests:
 *   - detect() on non-win32 → available=false, kind=none, confidence=verified
 *   - detect() on win32 → available=false (PR-A3 detect-only, spawn deferred)
 *   - spawn() always throws (not implemented in PR-A3)
 *   - Interface contract shape (detect result fields)
 *
 * PR-A3.5 will replace these with:
 *   - detect() win32 + native binding → available=true, kind=appcontainer
 *   - spawn() → valid SandboxedProcess
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { AppContainerRunner } from "../runners/appcontainer-runner.js";

afterEach(() => vi.restoreAllMocks());

function makeRunner(): AppContainerRunner {
  return new AppContainerRunner();
}

// ─── detect() — non-win32 platforms ──────────────────────────────────────────

describe("AppContainerRunner.detect() — non-win32 platforms", () => {
  it("returns available=false on linux", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const result = await makeRunner().detect();
    expect(result.available).toBe(false);
    expect(result.kind).toBe("none");
    expect(result.confidence).toBe("verified");
    expect(result.reason).toMatch(/only supports win32/i);
  });

  it("returns available=false on darwin", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const result = await makeRunner().detect();
    expect(result.available).toBe(false);
    expect(result.kind).toBe("none");
    expect(result.confidence).toBe("verified");
  });
});

// ─── detect() — win32 (PR-A3 detect-only) ────────────────────────────────────

describe("AppContainerRunner.detect() — win32 (PR-A3 detect-only)", () => {
  it("returns available=false on win32 in PR-A3 (native binding not yet implemented)", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const result = await makeRunner().detect();
    expect(result.available).toBe(false);
    expect(result.kind).toBe("none");
    expect(result.confidence).toBe("verified");
    expect(result.reason).toMatch(/PR-A3\.5/);
    expect(result.reason).toMatch(/N-API|native/i);
  });

  it("detect() result has all required SandboxRunnerDetect fields", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const result = await makeRunner().detect();
    expect(result).toMatchObject({
      available: expect.any(Boolean),
      reason: expect.any(String),
      kind: expect.stringMatching(/^(none|bubblewrap|sandbox-exec|appcontainer|partial|fs-only)$/),
      confidence: expect.stringMatching(/^(verified|assumed|policy-best-effort)$/),
    });
  });
});

// ─── spawn() — always throws in PR-A3 ────────────────────────────────────────

describe("AppContainerRunner.spawn() — always throws in PR-A3", () => {
  it("throws on linux with clear message about PR-A3.5", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const runner = makeRunner();
    await expect(runner.spawn("/bin/echo", [], {})).rejects.toThrow(/PR-A3\.5/);
  });

  it("throws on win32 with message about N-API binding", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const runner = makeRunner();
    await expect(runner.spawn("/bin/echo", [], {})).rejects.toThrow(/N-API|native/i);
  });

  it("throws on darwin with AppContainerRunner in message", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const runner = makeRunner();
    await expect(runner.spawn("/bin/echo", [], {})).rejects.toThrow(/AppContainerRunner/);
  });
});

// ─── Interface contract ───────────────────────────────────────────────────────

describe("AppContainerRunner interface contract", () => {
  it("detect() returns an object (never throws)", async () => {
    const runner = makeRunner();
    await expect(runner.detect()).resolves.toMatchObject({
      available: expect.any(Boolean),
      reason: expect.any(String),
    });
  });

  it("spawn() with full capabilities still throws (PR-A3 detect-only)", async () => {
    const runner = makeRunner();
    await expect(
      runner.spawn("/bin/echo", ["arg"], {
        networkBlocked: true,
        fsReadPaths: ["/tmp"],
        fsWritePaths: ["/tmp/out"],
        processIsolated: true,
      }),
    ).rejects.toThrow();
  });
});
