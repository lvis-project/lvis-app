import { describe, expect, it } from "vitest";
import {
  canonicalZipEntryPathIdentity,
  sanitizeZipEntryPath,
} from "../zip-entry-path.js";

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

  it.each([
    "plugin.json.",
    "skills/attendance ",
    "CON",
    "con.txt",
    "hooks/AUX.json",
    "NUL",
    "COM1",
    "mcp/LPT9.json",
    "COM¹.log",
    "file:stream",
    "bad<name",
    "bad>name",
    'bad"name',
    "bad|name",
    "bad?name",
    "bad*name",
  ])("rejects Windows-ambiguous or invalid archive segment: %s", (entryName) => {
    expect(() => sanitizeZipEntryPath("ep-api", entryName)).toThrow(/zip entry/);
  });

  it("uses a Unicode-aware case-insensitive member identity", () => {
    expect(canonicalZipEntryPathIdentity("skills/Straße/SKILL.md")).toBe(
      canonicalZipEntryPathIdentity("SKILLS/STRASSE/skill.md"),
    );
  });
});
