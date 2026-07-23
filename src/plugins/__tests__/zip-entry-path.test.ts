import { describe, expect, it } from "vitest";
import { sanitizeZipEntryPath } from "../zip-entry-path.js";

describe("sanitizeZipEntryPath", () => {
  it("preserves an unambiguous relative POSIX member name", () => {
    expect(sanitizeZipEntryPath("ep-api", "skills/attendance/SKILL.md")).toBe(
      "skills/attendance/SKILL.md",
    );
    expect(sanitizeZipEntryPath("ep-api", "skills/attendance/")).toBe("skills/attendance");
    expect(sanitizeZipEntryPath("ep-api", "")).toBeNull();
  });

  it.each([
    "/absolute/file",
    "C:/drive/file",
    "dir\\file",
    "safe/../escape",
    "safe/./file",
    "safe//file",
    "../escape",
    ".",
  ])("rejects raw unsafe archive syntax: %s", (entryName) => {
    expect(() => sanitizeZipEntryPath("ep-api", entryName)).toThrow(/zip entry/);
  });
});
