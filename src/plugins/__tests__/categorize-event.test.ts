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

  it("categorizes task events", () => {
    expect(categorizeEvent("task.created")).toBe("task");
  });

  it("returns 'other' for unknown namespaces", () => {
    expect(categorizeEvent("unknown.event")).toBe("other");
    expect(categorizeEvent("system.boot")).toBe("other");
  });

  it("handles bare event names without dots", () => {
    expect(categorizeEvent("email")).toBe("email");
    expect(categorizeEvent("unknown")).toBe("other");
  });
});
