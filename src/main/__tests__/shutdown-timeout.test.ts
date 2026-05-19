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

  it("aborts the cleanup signal on timeout so callers can break out", async () => {
    let captured: AbortSignal | undefined;
    const result = await runCleanupWithHardTimeout((signal) => {
      captured = signal;
      return new Promise<void>(() => {});
    }, 1);

    expect(result.status).toBe("timed-out");
    expect(captured?.aborted).toBe(true);
  });

  it("aborts the cleanup signal on rejection too", async () => {
    let captured: AbortSignal | undefined;
    const result = await runCleanupWithHardTimeout((signal) => {
      captured = signal;
      throw new Error("cleanup boom");
    }, 50);

    expect(result.status).toBe("failed");
    expect(captured?.aborted).toBe(true);
  });

  it("passes a non-aborted signal during the happy path", async () => {
    let signalDuringRun: boolean | undefined;
    const result = await runCleanupWithHardTimeout(async (signal) => {
      signalDuringRun = signal.aborted;
    }, 50);

    expect(result.status).toBe("completed");
    expect(signalDuringRun).toBe(false);
  });

  it("does not fire timeout when realistic cleanup steps finish under the budget", async () => {
    // Regression guard against "timeout becomes the default path" — if a
    // future plugin's stop() blows past the budget, this test detects the
    // drift before users hit data loss on every Quit.
    const result = await runCleanupWithHardTimeout(async () => {
      await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 10));
    }, 200);

    expect(result.status).toBe("completed");
  });
});
