import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expandLeadingTilde } from "../home-tilde.js";

describe("expandLeadingTilde", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("expands `~` and `~/...` to the home directory on every platform", () => {
    expect(expandLeadingTilde("~")).toBe(homedir());
    expect(expandLeadingTilde("~/hooks/run.sh")).toBe(resolve(homedir(), "hooks/run.sh"));
  });

  it("leaves paths without a leading tilde, and `~user` forms, alone", () => {
    expect(expandLeadingTilde("/usr/bin/env")).toBe("/usr/bin/env");
    expect(expandLeadingTilde("hooks/~/x")).toBe("hooks/~/x");
    expect(expandLeadingTilde("~alice/x")).toBe("~alice/x");
  });

  it("treats `~\\` as a separator form only where `\\` is a separator", () => {
    const original = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "linux" });
      expect(expandLeadingTilde("~\\x")).toBe("~\\x");
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(expandLeadingTilde("~\\x")).toBe(resolve(homedir(), "x"));
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });
});
