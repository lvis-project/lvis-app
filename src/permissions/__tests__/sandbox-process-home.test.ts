import { existsSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createSandboxProcessHome } from "../sandbox-process-home.js";

describe("createSandboxProcessHome", () => {
  it("creates a unique private profile and removes it idempotently", () => {
    const first = createSandboxProcessHome();
    const second = createSandboxProcessHome();
    try {
      expect(first.path).not.toBe(second.path);
      expect(first.env.HOME).toBe(first.path);
      expect(statSync(first.path).isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(first.path).mode & 0o777).toBe(0o700);
      }

      if (process.platform === "win32") {
        expect(first.env.USERPROFILE).toBe(first.path);
        expect(first.env.APPDATA).toContain(first.path);
        expect(first.env.LOCALAPPDATA).toContain(first.path);
      } else {
        expect(first.env.XDG_CONFIG_HOME).toContain(first.path);
        expect(first.env.XDG_DATA_HOME).toContain(first.path);
        expect(first.env.XDG_CACHE_HOME).toContain(first.path);
        expect(first.env.XDG_STATE_HOME).toContain(first.path);
      }

      writeFileSync(`${first.path}/.gitconfig`, "[test]\nvalue = isolated\n", "utf8");
    } finally {
      first.cleanup();
      first.cleanup();
      second.cleanup();
    }

    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
  });
});
