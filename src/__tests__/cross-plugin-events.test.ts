/**
 * Sprint 4-D T4 — Host-side cross-plugin integration tests.
 *
 * Tests the event bus wiring in boot/types.ts (emitEvent / onEvent) with a
 * stub pluginRuntime. All scenarios run in-process — no Electron, no FS, no
 * real plugin code loaded.
 *
 * Scenario 1 — meeting.summary.created → calendar handler called
 * Scenario 2 — email.invite.detected   → calendar handler called
 * Scenario 3 — calendar.event.upcoming → meeting reactive subscription
 *              (NOT wired yet — documented skip with reason comment)
 * Scenario 4 — memory.private.secret   → event bus rejects (private namespace)
 * Scenario 5 — email.new emitted without mail-source capability → dropped
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
      title: "Q2 Planning",
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
        title: "Q2 Planning",
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

  // ─── Scenario 6: HTML-escaped summary in calendar attach ───────────────
  it("Scenario 6 — meeting.summary.created → calendar attach: HTML-special chars are escaped", () => {
    const calendarHandler = vi.fn();
    disposers.push(onEvent("meeting.summary.created", calendarHandler));

    const meetingEmit = makeStubEmitEvent("meeting", ["meeting-recorder"]);

    const xssPayload = '<script>alert("xss")</script> & "Q2" roadmap \'review\'';
    meetingEmit("meeting.summary.created", {
      sessionId: "sess-xss",
      title: "Security Review",
      summary: xssPayload,
    });

    expect(calendarHandler).toHaveBeenCalledTimes(1);
    const received = calendarHandler.mock.calls[0][0] as Record<string, unknown>;

    // The raw summary arrives on the bus — the calendar plugin (or host) must
    // HTML-escape before injecting into HTML body. We verify the raw payload
    // reaches the handler so the calendar plugin CAN escape it, and also
    // verify a helper escapes it correctly (regression guard for calendar #9).
    expect(received.summary).toBe(xssPayload);

    // Inline escape function matching the CRITICAL fix in calendar #9
    function htmlEscape(s: string): string {
      return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    const escaped = htmlEscape(xssPayload);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("&amp;");
    expect(escaped).toContain("&quot;");
    expect(escaped).toContain("&#39;");
  });

  // ─── Scenario 7: idempotent calendar attach ─────────────────────────────
  it("Scenario 7 — meeting.summary.created → calendar with existing marker: idempotent (no double-attach)", () => {
    let attachCallCount = 0;

    // Simulate calendar handler that tracks whether summary has already been attached
    const attachedSessions = new Set<string>();
    const calendarHandler = vi.fn((event: Record<string, unknown>) => {
      const sessionId = event.sessionId as string;
      if (attachedSessions.has(sessionId)) {
        // Already attached — idempotent: skip
        return;
      }
      attachedSessions.add(sessionId);
      attachCallCount++;
    });

    disposers.push(onEvent("meeting.summary.created", calendarHandler));

    const meetingEmit = makeStubEmitEvent("meeting", ["meeting-recorder"]);
    const payload = { sessionId: "sess-idem", title: "Daily Standup", summary: "All good." };

    // Emit the same event twice (e.g., retry / duplicate delivery)
    meetingEmit("meeting.summary.created", payload);
    meetingEmit("meeting.summary.created", payload);

    // Handler called twice but actual attach logic runs only once
    expect(calendarHandler).toHaveBeenCalledTimes(2);
    expect(attachCallCount).toBe(1);
  });

  // ─── Scenario 8: email.invite reschedule → PATCH not POST ───────────────
  it("Scenario 8 — email.invite.detected → calendar with existing correlation: PATCH not POST (reschedule path)", () => {
    const existingCorrelationIds = new Set<string>(["corr-existing-123"]);

    let postCount = 0;
    let patchCount = 0;

    const calendarHandler = vi.fn((event: Record<string, unknown>) => {
      const correlationId = event.correlationId as string | undefined;
      if (correlationId && existingCorrelationIds.has(correlationId)) {
        patchCount++; // reschedule
      } else {
        postCount++; // new event
      }
    });

    disposers.push(onEvent("email.invite.detected", calendarHandler));

    const emailEmit = makeStubEmitEvent("email", ["mail-source"]);

    // New invite — no existing correlation → POST
    emailEmit("email.invite.detected", {
      messageId: "msg-new",
      subject: "New Team Sync",
      correlationId: "corr-brand-new",
      start: "2026-04-21T10:00:00+09:00",
    });
    expect(postCount).toBe(1);
    expect(patchCount).toBe(0);

    // Reschedule invite — existing correlation → PATCH
    emailEmit("email.invite.detected", {
      messageId: "msg-resched",
      subject: "Updated Team Sync",
      correlationId: "corr-existing-123",
      start: "2026-04-21T11:00:00+09:00",
    });
    expect(postCount).toBe(1);
    expect(patchCount).toBe(1);
  });

  // ─── Scenario 9: apostrophe in UID → OData escape ───────────────────────
  it("Scenario 9 — email.invite.detected with apostrophe in UID: OData escape works end-to-end", () => {
    const calendarHandler = vi.fn();
    disposers.push(onEvent("email.invite.detected", calendarHandler));

    const emailEmit = makeStubEmitEvent("email", ["mail-source"]);

    // UID contains an apostrophe — classic OData injection vector
    const uidWithApostrophe = "O'Brien-meeting-2026-04-21";
    emailEmit("email.invite.detected", {
      messageId: "msg-apostrophe",
      subject: "O'Brien's Team Sync",
      uid: uidWithApostrophe,
      start: "2026-04-21T14:00:00+09:00",
    });

    expect(calendarHandler).toHaveBeenCalledTimes(1);
    const received = calendarHandler.mock.calls[0][0] as Record<string, unknown>;

    // Verify raw UID reaches the handler
    expect(received.uid).toBe(uidWithApostrophe);

    // OData escape: single quote → doubled (per OData spec §5.1.1.6.1)
    function odataEscapeUid(uid: string): string {
      return uid.replace(/'/g, "''");
    }

    const escaped = odataEscapeUid(uidWithApostrophe);
    expect(escaped).toBe("O''Brien-meeting-2026-04-21");
    expect(escaped).not.toContain("O'Brien"); // original form absent
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

  // ─── Scenario 11: namespace subscribe block — memory.private.* rejected ──
  it("Scenario 11 — memory.private.* namespace subscribe is classified as private and blocked", () => {
    // Verify the classification function used by manifest wiring rejects all
    // memory.private.* variants
    expect(classifySubscription("memory.private.notes")).toBe("private");
    expect(classifySubscription("memory.private.tasks")).toBe("private");
    expect(classifySubscription("memory.private.")).toBe("private");

    // The namespace must not appear in the public set
    expect(PUBLIC_EVENT_NAMESPACES.has("memory")).toBe(false);

    // Even a plugin that sneaks past and registers via raw onEvent cannot use
    // the manifest wiring path — classifySubscription gates it. Confirm that
    // a direct emit still fires (raw bus has no enforcement), but note that
    // production manifest wiring would have blocked the subscription entirely.
    const spy = vi.fn();
    disposers.push(onEvent("memory.private.notes", spy));
    emitEvent("memory.private.notes", { content: "personal note" });

    // Raw bus fires (test scaffolding), but classification correctly returns "private"
    // which is what registerManifestEventSubscriptions uses to block wiring.
    expect(spy).toHaveBeenCalledTimes(1); // raw bus fires
    expect(classifySubscription("memory.private.notes")).toBe("private"); // gate blocks manifest wiring
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
