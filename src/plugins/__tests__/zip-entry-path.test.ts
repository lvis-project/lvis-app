import { describe, expect, it } from "vitest";
import {
  canonicalZipEntryPathIdentity,
  sanitizeZipEntryPath,
} from "../zip-entry-path.js";

/**
 * A published artifact may not ship the plugin's own runtime directories. The
 * install swap carries the LIVE `data/` into the promoted root as its last
 * step, so a payload arriving with one leaves two candidates for one state and
 * no way to merge them — and `run/`/`sockets/` would arrive on top of the
 * host's and the plugin's socket directories.
 */
describe("sanitizeZipEntryPath — reserved runtime directories", () => {
  it.each([
    "data/state.json",
    "data/",
    "data",
    "run/worker/control.sock",
    "sockets/egress.sock",
    // Case-folded on macOS and Windows, where the payload would land on the
    // live directory even though the names differ byte for byte.
    "Data/state.json",
    "SOCKETS/egress.sock",
  ])("refuses %s", (entryName) => {
    expect(() => sanitizeZipEntryPath("ep-api", entryName)).toThrow(
      /reserved plugin runtime directory name/,
    );
  });

  it("keeps the same names when they are nested inside the payload", () => {
    expect(sanitizeZipEntryPath("ep-api", "dist/data/seed.json")).toBe("dist/data/seed.json");
    expect(sanitizeZipEntryPath("ep-api", "database/schema.sql")).toBe("database/schema.sql");
  });
});

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
