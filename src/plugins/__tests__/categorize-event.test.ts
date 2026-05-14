import { describe, it, expect } from "vitest";
import { categorizeEvent } from "../capabilities.js";

describe("categorizeEvent", () => {
  it("categorizes email events", () => {
    expect(categorizeEvent("email.action.needed")).toBe("email");
    expect(categorizeEvent("email.received")).toBe("email");
  });

  it("categorizes meeting events", () => {
    expect(categorizeEvent("meeting.summary.created")).toBe("meeting");
  });

  it("categorizes calendar events", () => {
    expect(categorizeEvent("calendar.event.created")).toBe("calendar");
  });

  it("categorizes index events", () => {
    expect(categorizeEvent("index.document.added")).toBe("index");
  });

  it("categorizes explicit public host events without opening the host namespace", () => {
    expect(categorizeEvent("host.theme.changed")).toBe("host");
    expect(categorizeEvent("host.secret.changed")).toBe("other");
  });

  it("returns 'other' for unknown / plugin-owned namespaces (host stays agnostic to plugin ids)", () => {
    expect(categorizeEvent("unknown.event")).toBe("other");
    expect(categorizeEvent("system.boot")).toBe("other");
    // task.* retired 2026-05-11 — host owner removed in Phase 4
    expect(categorizeEvent("task.created")).toBe("other");
    // Plugin-owned namespaces are NOT in PUBLIC_EVENT_NAMESPACES
    // (open-source-readiness) — categorized as "other".
    expect(categorizeEvent("agent_hub.work_item.due_soon")).toBe("other");
  });

  it("handles bare event names without dots", () => {
    expect(categorizeEvent("email")).toBe("email");
    expect(categorizeEvent("unknown")).toBe("other");
  });
});
