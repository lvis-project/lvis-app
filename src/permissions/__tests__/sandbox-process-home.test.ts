import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSandboxProcessHome,
  sandboxProcessProfileEnvironment,
} from "../sandbox-process-home.js";

afterEach(() => {
  vi.useRealTimers();
});

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
        expect(first.env.HOMEDRIVE).toBeDefined();
        expect(first.env.HOMEPATH).toBeDefined();
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

  it("overrides the Windows HOME drive pair for a non-drive temp path", () => {
    const path = "\\\\server\\temp\\lvis-sandbox-home-test";
    const env = sandboxProcessProfileEnvironment(path, "win32");
    expect(env.HOMEDRIVE).toBe("");
    expect(env.HOMEPATH).toBe(path);
  });

  it("keeps cleanup retryable until the profile is actually absent", () => {
    let attempts = 0;
    const profile = createSandboxProcessHome(process.platform, (path, options) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("locked") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      rmSync(path, options);
    });
    profile.cleanup();
    expect(existsSync(profile.path)).toBe(true);
    profile.cleanup();
    expect(attempts).toBe(2);
    expect(existsSync(profile.path)).toBe(false);
  });

  it("automatically retries a transient cleanup failure", () => {
    vi.useFakeTimers();
    let attempts = 0;
    const profile = createSandboxProcessHome(process.platform, (path, options) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("busy") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      rmSync(path, options);
    });

    profile.cleanup();
    expect(existsSync(profile.path)).toBe(true);
    vi.advanceTimersByTime(50);
    expect(attempts).toBe(2);
    expect(existsSync(profile.path)).toBe(false);
  });
});
