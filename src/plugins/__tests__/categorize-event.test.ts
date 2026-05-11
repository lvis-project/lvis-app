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

  it("categorizes agent_hub events", () => {
    expect(categorizeEvent("agent_hub.work_item.due_soon")).toBe("agent_hub");
    expect(categorizeEvent("agent_hub.work_log.posted")).toBe("agent_hub");
  });

  it("returns 'other' for unknown namespaces", () => {
    expect(categorizeEvent("unknown.event")).toBe("other");
    expect(categorizeEvent("system.boot")).toBe("other");
    // task.* retired 2026-05-11 — host owner removed in Phase 4
    expect(categorizeEvent("task.created")).toBe("other");
  });

  it("handles bare event names without dots", () => {
    expect(categorizeEvent("email")).toBe("email");
    expect(categorizeEvent("unknown")).toBe("other");
    // Lock the underscore-in-namespace path — regression risk if
    // someone replaces `split(".")[0]` with a `[a-z]+` regex.
    expect(categorizeEvent("agent_hub")).toBe("agent_hub");
  });
});
