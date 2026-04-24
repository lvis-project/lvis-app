import { describe, expect, it, vi } from "vitest";
import { RoutineEngine } from "../routine-engine.js";

function makeEngine(overrides: Partial<ConstructorParameters<typeof RoutineEngine>[0]> = {}) {
  const pluginRuntime = {
    call: vi.fn(),
  };
  const deps = {
    pluginRuntime: pluginRuntime as any,
    isDailyBriefingEnabled: () => true,
    getLastBriefingDate: () => undefined,
    setLastBriefingDate: vi.fn(),
    getLastDismissedAt: () => undefined,
    dailyBriefingTool: "work_proactive_generate_wakeup_briefing",
    ...overrides,
  };
  return { engine: new RoutineEngine(deps), pluginRuntime, deps };
}

describe("RoutineEngine.generateDailyBriefing", () => {
  it("skips when disabled, not idle, already today, or recently dismissed", async () => {
    const disabled = makeEngine({ isDailyBriefingEnabled: () => false });
    await expect(disabled.engine.generateDailyBriefing({ idleState: "triggered" })).resolves.toEqual({
      status: "skipped",
      reason: "disabled",
    });

    const notIdle = makeEngine();
    await expect(notIdle.engine.generateDailyBriefing({ idleState: "active" })).resolves.toEqual({
      status: "skipped",
      reason: "not_idle",
    });

    const alreadyToday = makeEngine({ getLastBriefingDate: () => "2026-04-24" });
    await expect(
      alreadyToday.engine.generateDailyBriefing({
        idleState: "triggered",
        now: new Date("2026-04-23T23:30:00Z"),
      }),
    ).resolves.toEqual({ status: "skipped", reason: "already_today" });

    const dismissed = makeEngine({
      getLastDismissedAt: () => "2026-04-24T00:00:00.000Z",
    });
    await expect(
      dismissed.engine.generateDailyBriefing({
        idleState: "triggered",
        now: new Date("2026-04-24T01:00:00.000Z"),
      }),
    ).resolves.toEqual({ status: "skipped", reason: "recently_dismissed" });
  });

  it("skips when provider throws, returns invalid payload, or has no meaningful content", async () => {
    const throws = makeEngine();
    throws.pluginRuntime.call.mockRejectedValueOnce(new Error("boom"));
    await expect(throws.engine.generateDailyBriefing({ idleState: "triggered" })).resolves.toEqual({
      status: "skipped",
      reason: "provider_unavailable",
    });

    const invalid = makeEngine();
    invalid.pluginRuntime.call.mockResolvedValueOnce({ nope: true });
    await expect(invalid.engine.generateDailyBriefing({ idleState: "triggered" })).resolves.toEqual({
      status: "skipped",
      reason: "provider_unavailable",
    });

    const empty = makeEngine();
    empty.pluginRuntime.call.mockResolvedValueOnce({
      generatedAt: new Date().toISOString(),
      items: [],
      summary: "   ",
    });
    await expect(empty.engine.generateDailyBriefing({ idleState: "triggered" })).resolves.toEqual({
      status: "skipped",
      reason: "no_signals",
    });
  });

  it("marks in-flight requests and persists successful day keys", async () => {
    let resolveCall: ((value: unknown) => void) | null = null;
    const inFlight = makeEngine();
    inFlight.pluginRuntime.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCall = resolve;
        }),
    );
    const first = inFlight.engine.generateDailyBriefing({ idleState: "triggered" });
    const second = await inFlight.engine.generateDailyBriefing({ idleState: "triggered" });
    expect(second).toEqual({ status: "skipped", reason: "in_flight" });
    resolveCall?.({
      generatedAt: new Date().toISOString(),
      items: [{ category: "system", priority: "low", title: "ok" }],
      summary: "ok",
    });
    const resolved = await first;
    expect(resolved.status).toBe("generated");
    expect(inFlight.deps.setLastBriefingDate).toHaveBeenCalled();
  });
});
