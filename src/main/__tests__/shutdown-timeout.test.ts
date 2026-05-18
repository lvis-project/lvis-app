import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS,
  resolveShutdownCleanupTimeoutMs,
  runCleanupWithHardTimeout,
} from "../shutdown-timeout.js";

describe("shutdown cleanup hard timeout", () => {
  it("returns completed when cleanup resolves before the deadline", async () => {
    await expect(runCleanupWithHardTimeout(async () => {}, 50)).resolves.toEqual({
      status: "completed",
    });
  });

  it("returns failed when cleanup rejects before the deadline", async () => {
    const result = await runCleanupWithHardTimeout(async () => {
      throw new Error("cleanup failed");
    }, 50);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe("cleanup failed");
    }
  });

  it("returns timed-out when cleanup does not settle", async () => {
    await expect(
      runCleanupWithHardTimeout(() => new Promise<void>(() => {}), 1),
    ).resolves.toEqual({ status: "timed-out" });
  });

  it("resolves timeout from env with compatibility fallback", () => {
    expect(resolveShutdownCleanupTimeoutMs({ LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS: "1234" })).toBe(1234);
    expect(resolveShutdownCleanupTimeoutMs({ LVIS_SHUTDOWN_TIMEOUT_MS: "2345" })).toBe(2345);
    expect(resolveShutdownCleanupTimeoutMs({ LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS: "-1" })).toBe(
      DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS,
    );
  });
});
