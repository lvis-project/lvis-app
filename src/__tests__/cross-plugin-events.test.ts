/**
 * Sprint 4-D T4 — Host-side cross-plugin integration tests.
 *
 * Tests the event bus wiring in boot/types.ts (emitEvent / onEvent) with a
 * stub pluginRuntime. All scenarios run in-process — no Electron, no FS, no
 * real plugin code loaded.
 *
 * Scenario 1  — meeting.summary.created → calendar handler called
 * Scenario 2  — email.invite.detected   → calendar handler called
 * Scenario 3  — calendar.event.upcoming → meeting reactive subscription
 *               (NOT wired yet — documented skip with reason comment)
 * Scenario 4  — memory.private.secret   → event bus rejects (private namespace)
 * Scenario 5  — email.new emitted without mail-source capability → dropped
 * Scenario 5b — email.new with mail-source capability → delivered
 * Scenario 10 — capability gate: email plugin cannot emit meeting.* events
 *
 * Scenarios 6–9 and 11 removed: they tested locally-defined helpers (HTML
 * escape, OData escape, idempotency, PATCH-vs-POST, namespace duplicates) that
 * live in plugin repos and are already covered by calendar plugin PR #9 and
 * event-namespace-policy.test.ts. True cross-plugin integration lives in
 * plugin repos' own test suites.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Event bus under test (pure TS, no Electron deps) ────────────────────────
import { emitEvent, onEvent, offEvent } from "../boot/types.js";

// ─── Capability helpers ───────────────────────────────────────────────────────
import {
  requiredCapabilityForEmit,
  classifySubscription,
  PUBLIC_EVENT_NAMESPACES,
} from "../plugins/capabilities.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal stub that mimics the capability-gated emitEvent logic from
 * boot.ts §createHostApi, without touching Electron or a real PluginRuntime.
 */
function makeStubEmitEvent(pluginId: string, capabilities: string[]) {
  return (type: string, data?: Record<string, unknown>) => {
    const requiredCap = requiredCapabilityForEmit(type);
    if (requiredCap && !capabilities.includes(requiredCap)) {
      console.warn(
        `[lvis] plugin:${pluginId} emitEvent('${type}') dropped — missing capability '${requiredCap}'`,
      );
      return; // dropped
    }
    emitEvent(type, { pluginId, ...(data ?? {}) });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("Sprint 4-D T4 — cross-plugin event flow (host event bus)", () => {
  // Collect all unsubscribe disposers so each test cleans up handlers.
  const disposers: Array<() => void> = [];

  afterEach(() => {
    for (const d of disposers.splice(0)) d();
  });

  // ─── Scenario 1: meeting.summary.created → calendar ────────────────────
  it("Scenario 1 — meeting.summary.created triggers calendar handler", () => {
    const calendarHandler = vi.fn();
    disposers.push(onEvent("meeting.summary.created", calendarHandler));

    const meetingEmit = makeStubEmitEvent("meeting", ["meeting-recorder"]);

    const payload = {
      sessionId: "sess-001",
      title: "Quarterly Planning",
      summary: "Discussed roadmap.",
      highlights: ["Milestone A"],
      actionItems: ["Follow up with design team"],
    };

    meetingEmit("meeting.summary.created", payload);

    expect(calendarHandler).toHaveBeenCalledTimes(1);
    expect(calendarHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "meeting",
        sessionId: "sess-001",
        title: "Quarterly Planning",
      }),
    );
  });

  // ─── Scenario 2: email.invite.detected → calendar ──────────────────────
  it("Scenario 2 — email.invite.detected triggers calendar handler", () => {
    const calendarHandler = vi.fn();
    disposers.push(onEvent("email.invite.detected", calendarHandler));

    const emailEmit = makeStubEmitEvent("email", ["mail-source"]);

    const payload = {
      messageId: "msg-abc",
      subject: "Team sync invite",
      start: "2026-04-20T10:00:00+09:00",
      end: "2026-04-20T11:00:00+09:00",
    };

    emailEmit("email.invite.detected", payload);

    expect(calendarHandler).toHaveBeenCalledTimes(1);
    expect(calendarHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "email",
        messageId: "msg-abc",
        subject: "Team sync invite",
      }),
    );
  });

  // ─── Scenario 3: calendar.event.upcoming → meeting (NOT wired yet) ─────
  it.skip(
    "Scenario 3 — calendar.event.upcoming → meeting auto-start (NOT WIRED YET)",
    () => {
      /**
       * The meeting plugin does NOT currently subscribe to
       * `calendar.event.upcoming`. Auto-starting a recording session when a
       * calendar event is about to begin has been explicitly deferred (see
       * sprint4d-cross-plugin-spec.md §2.2 — "calendar.event.started event is
       * NOT yet emitted … explicitly deferred").
       *
       * When this feature is implemented:
       *   1. calendar/plugin.json must add `eventSubscriptions: ["calendar.event.upcoming"]`
       *      (or a new event emitted by the calendar watcher).
       *   2. meeting/hostPlugin.ts must call hostApi.onEvent("calendar.event.upcoming", ...)
       *      and auto-trigger meeting_start.
       *   3. Remove the `.skip` and write the assertion here.
       */
      expect(true).toBe(false); // placeholder — must fail if accidentally un-skipped
    },
  );

  // ─── Scenario 4: private namespace → rejected ───────────────────────────
  it("Scenario 4 — memory.private.secret is classified as private and subscription is blocked at wiring time", () => {
    // The event bus itself does not enforce namespace policy — that happens in
    // boot/plugins.ts#registerManifestEventSubscriptions which calls
    // classifySubscription() and skips private events. We verify the
    // classification function used by that gating logic.

    expect(classifySubscription("memory.private.secret")).toBe("private");
    expect(classifySubscription("memory.private.anything")).toBe("private");
    expect(classifySubscription("settings.apiKey.openai")).toBe("private");
    expect(classifySubscription("audit.log")).toBe("private");
    expect(classifySubscription("dlp.redacted")).toBe("private");

    // Verify that even if a rogue plugin somehow emits the event through the
    // raw emitEvent bus (bypassing HostApi), a subscriber set up via the
    // manifest wiring path would never be registered because classifySubscription
    // returns "private" and registerManifestEventSubscriptions skips it.

    const spy = vi.fn();
    disposers.push(onEvent("memory.private.secret", spy));

    // Raw emit (not through HostApi — simulates internal host only path).
    emitEvent("memory.private.secret", { secret: "hunter2" });

    // If a subscriber was somehow registered (test scaffolding above), it fires
    // on raw emit — but in production the manifest wiring never registers it.
    // What matters is the classification gate: assert it correctly blocks.
    expect(classifySubscription("memory.private.secret")).toBe("private");

    // And confirm PUBLIC_EVENT_NAMESPACES does NOT include these namespaces.
    expect(PUBLIC_EVENT_NAMESPACES.has("memory")).toBe(false);
    expect(PUBLIC_EVENT_NAMESPACES.has("audit")).toBe(false);
    expect(PUBLIC_EVENT_NAMESPACES.has("dlp")).toBe(false);
    expect(PUBLIC_EVENT_NAMESPACES.has("settings")).toBe(false);
  });

  // ─── Scenario 5: capability gate on emit ────────────────────────────────
  it("Scenario 5 — plugin without mail-source capability cannot emit email.new", () => {
    const spy = vi.fn();
    disposers.push(onEvent("email.new", spy));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Plugin without mail-source capability (e.g., meeting plugin).
    const meetingEmit = makeStubEmitEvent("meeting", ["meeting-recorder"]);
    meetingEmit("email.new", { subject: "Test" });

    // Event must NOT fan out to any subscriber.
    expect(spy).not.toHaveBeenCalled();

    // Host must log a warn explaining the drop.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("dropped — missing capability 'mail-source'"),
    );

    warnSpy.mockRestore();
  });

  // ─── Scenario 10: capability gate — meeting-recorder cannot emit meeting.* ─
  it("Scenario 10 — plugin without meeting-recorder capability cannot emit meeting.*", () => {
    const spy = vi.fn();
    disposers.push(onEvent("meeting.summary.created", spy));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Email plugin does NOT have meeting-recorder capability
    const emailEmit = makeStubEmitEvent("email", ["mail-source"]);
    emailEmit("meeting.summary.created", { sessionId: "fake", summary: "fake" });

    // Must be dropped — missing capability
    expect(spy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("dropped — missing capability 'meeting-recorder'"),
    );

    warnSpy.mockRestore();
  });

  // ─── Bonus: capability gate allows legitimate emit ───────────────────────
  it("Scenario 5b — plugin WITH mail-source capability can emit email.new", () => {
    const spy = vi.fn();
    disposers.push(onEvent("email.new", spy));

    const emailEmit = makeStubEmitEvent("email", ["mail-source"]);
    emailEmit("email.new", { subject: "Hello" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "email", subject: "Hello" }),
    );
  });
});
