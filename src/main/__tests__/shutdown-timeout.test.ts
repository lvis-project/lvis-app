import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS,
  resolveShutdownCleanupTimeoutMs,
  runCleanupWithHardTimeout,
} from "../shutdown-timeout.js";
import { MAX_TIMER_DELAY_MS } from "../../shared/tool-timeout-policy.js";

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

  it("resolves timeout from the canonical env var", () => {
    expect(
      resolveShutdownCleanupTimeoutMs(undefined, { LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS: "1234" }),
    ).toBe(1234);
    expect(
      resolveShutdownCleanupTimeoutMs(undefined, { LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS: "-1" }),
    ).toBe(DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS);
  });

  it("ignores the retired LVIS_SHUTDOWN_TIMEOUT_MS alias", () => {
    // Published removal date 2026-08-01. A host still exporting it gets the
    // default — exactly what the deprecation warning promised would happen,
    // and NOT a silent honoring of a name that no longer exists.
    expect(
      resolveShutdownCleanupTimeoutMs(undefined, {
        LVIS_SHUTDOWN_TIMEOUT_MS: "2345",
      } as NodeJS.ProcessEnv),
    ).toBe(DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS);
  });

  it("falls back to the default for NaN / non-numeric / zero env values", () => {
    expect(
      resolveShutdownCleanupTimeoutMs(undefined, { LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS: "abc" }),
    ).toBe(DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS);
    expect(
      resolveShutdownCleanupTimeoutMs(undefined, { LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS: "0" }),
    ).toBe(DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS);
  });

  it("returns the default when neither the setting nor the env decides", () => {
    expect(resolveShutdownCleanupTimeoutMs(undefined, {})).toBe(
      DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS,
    );
  });

  it("uses the saved setting when the environment is silent", () => {
    expect(resolveShutdownCleanupTimeoutMs(30_000, {})).toBe(30_000);
  });

  it("lets the environment override the saved setting", () => {
    // A launcher script or an MDM profile pinning the variable outranks the
    // profile, which is the whole reason the pair is in ENV_BACKED_SETTINGS.
    expect(
      resolveShutdownCleanupTimeoutMs(30_000, { LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS: "45000" }),
    ).toBe(45_000);
  });

  it("falls through to the setting when the env value is unusable", () => {
    // NOT to the default: an env value that says nothing must not also erase
    // the choice the user did make.
    expect(
      resolveShutdownCleanupTimeoutMs(30_000, { LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS: "abc" }),
    ).toBe(30_000);
  });

  it("rejects a saved setting that could never be a timeout", () => {
    expect(resolveShutdownCleanupTimeoutMs(0, {})).toBe(DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS);
    expect(resolveShutdownCleanupTimeoutMs(-5, {})).toBe(DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS);
    expect(resolveShutdownCleanupTimeoutMs(Number.NaN, {})).toBe(
      DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS,
    );
  });

  it("clamps a value past Node's timer ceiling instead of letting it overflow", () => {
    // Above MAX_TIMER_DELAY_MS `setTimeout` warns and substitutes 1ms, so an
    // operator asking for a very long grace period would get a cleanup killed
    // almost instantly — the opposite of what they asked for.
    expect(
      resolveShutdownCleanupTimeoutMs(undefined, {
        LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS: String(MAX_TIMER_DELAY_MS + 1_000),
      }),
    ).toBe(MAX_TIMER_DELAY_MS);
    expect(resolveShutdownCleanupTimeoutMs(MAX_TIMER_DELAY_MS * 2, {})).toBe(MAX_TIMER_DELAY_MS);
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
