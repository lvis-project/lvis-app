import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  buildDevProtocolArgs,
  resolveScriptPathArg,
} from "../electron-protocol-args.js";

describe("resolveScriptPathArg", () => {
  it("returns the argv string when it is a normal script path", () => {
    expect(resolveScriptPathArg("dist/src/main.js")).toBe("dist/src/main.js");
  });

  it("falls back to '.' when argv is missing", () => {
    expect(resolveScriptPathArg(undefined)).toBe(".");
  });

  it("rejects a lvis:// URL (cold-start argv pollution)", () => {
    expect(resolveScriptPathArg("lvis://install/foo")).toBe(".");
    // RFC 3986 §3.1 — scheme is case-insensitive.
    expect(resolveScriptPathArg("LVIS://install/foo")).toBe(".");
  });

  it("rejects an Electron switch like --user-data-dir=...", () => {
    expect(resolveScriptPathArg("--user-data-dir=C:/users/x/AppData")).toBe(".");
    expect(resolveScriptPathArg("--disable-gpu")).toBe(".");
  });
});

describe("buildDevProtocolArgs", () => {
  function args(overrides: Partial<Parameters<typeof buildDevProtocolArgs>[0]> = {}) {
    return buildDevProtocolArgs({
      argv1: "dist/src/main.js",
      userDataDir: "/tmp/userdata",
      platform: "linux",
      env: {},
      ...overrides,
    });
  }

  it("returns a resolved script path as the first arg", () => {
    const out = args({ argv1: "dist/src/main.js" });
    expect(out[0]).toBe(resolve("dist/src/main.js"));
  });

  it("appends --user-data-dir when provided", () => {
    expect(args({ userDataDir: "/x/y" })).toContain("--user-data-dir=/x/y");
  });

  it("omits --user-data-dir when undefined", () => {
    expect(args({ userDataDir: undefined })).not.toContain(expect.stringMatching(/^--user-data-dir/));
  });

  it("does NOT add Windows-safe GPU flags on non-win32 platforms", () => {
    const out = args({ platform: "darwin" });
    expect(out).not.toContain("--disable-gpu");
    expect(out).not.toContain("--no-sandbox");
  });

  it("adds Windows-safe GPU flags on win32 by default", () => {
    const out = args({ platform: "win32" });
    expect(out).toContain("--disable-gpu");
    expect(out).toContain("--disable-software-rasterizer");
    expect(out).toContain("--disable-gpu-compositing");
  });

  it("skips Windows GPU flags when LVIS_KEEP_GPU=1", () => {
    const out = args({ platform: "win32", env: { LVIS_KEEP_GPU: "1" } });
    expect(out).not.toContain("--disable-gpu");
  });

  it("adds --no-sandbox only when LVIS_DEV_NO_SANDBOX=1", () => {
    expect(args({ platform: "win32", env: {} })).not.toContain("--no-sandbox");
    expect(args({ platform: "win32", env: { LVIS_DEV_NO_SANDBOX: "1" } })).toContain("--no-sandbox");
  });

  it("does not register a script-path arg derived from a lvis:// URL", () => {
    // This is the cold-start argv pollution guard — the registered command
    // must not embed the URL itself as a script path, which would corrupt
    // every subsequent OS launch.
    const out = args({ argv1: "lvis://install/agent-hub" });
    expect(out[0]).toBe(resolve("."));
    // None of the args should contain the lvis:// URL.
    for (const a of out) expect(a).not.toMatch(/^lvis:\/\//i);
  });

  it("does not embed an Electron switch as a script-path arg", () => {
    const out = args({ argv1: "--user-data-dir=C:/users/x" });
    expect(out[0]).toBe(resolve("."));
    // The intentional `--user-data-dir=` from the userDataDir input is fine,
    // but argv1's polluted switch must not surface as the leading arg.
    expect(out.filter((a) => a.startsWith("--user-data-dir="))).toHaveLength(1);
  });
});
