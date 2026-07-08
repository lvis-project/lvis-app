import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  isAsrtWindowsReady,
  normalizeAsrtWindowsUserState,
  normalizeAsrtWindowsWfpState,
  resolveAsrtWindowsReady,
} from "../asrt-windows-support.js";

function readAsrtSandboxManagerSource(): string {
  const require = createRequire(import.meta.url);
  const indexPath = require.resolve("@anthropic-ai/sandbox-runtime");
  return readFileSync(join(dirname(indexPath), "sandbox", "sandbox-manager.js"), "utf-8");
}

describe("asrt-windows-support adapter", () => {
  it("normalizes the ASRT 0.0.64 ready sandbox-user shape", () => {
    expect(
      normalizeAsrtWindowsUserState({
        provisioned: true,
        sid: "S-1-5-21-1",
        groupExists: true,
        inBuiltinUsers: true,
        inSandboxGroup: true,
        hiddenFromLogon: true,
        credPresent: true,
      }),
    ).toBe("ready");
  });

  it("treats partial sandbox-user provisioning as incomplete, not ready", () => {
    expect(
      normalizeAsrtWindowsUserState({
        provisioned: true,
        sid: "S-1-5-21-1",
        groupExists: true,
      }),
    ).toBe("incomplete");
  });

  it("treats an empty sandbox-user status as absent", () => {
    expect(normalizeAsrtWindowsUserState({})).toBe("absent");
  });

  it("normalizes WFP status conservatively", () => {
    expect(normalizeAsrtWindowsWfpState({ state: "installed" })).toBe("installed");
    expect(normalizeAsrtWindowsWfpState({ state: "cannot-read" })).toBe("cannot-read");
    expect(normalizeAsrtWindowsWfpState({ state: "unexpected-upstream-state" })).toBe("absent");
  });

  it("requires both sandbox user and WFP to be ready", () => {
    expect(isAsrtWindowsReady("ready", "installed")).toBe(true);
    expect(isAsrtWindowsReady("ready", "cannot-read")).toBe(false);
    expect(isAsrtWindowsReady("incomplete", "installed")).toBe(false);
  });

  it("treats cannot-read WFP as ready only when ASRT behavioral verification succeeds", async () => {
    const verified = await resolveAsrtWindowsReady("ready", "cannot-read", async () => ({
      target: "127.0.0.1:49152",
      stderr: "BLOCKED",
    }));
    expect(verified).toBe(true);

    const failed = await resolveAsrtWindowsReady("ready", "cannot-read", async () => {
      throw new Error("WFP egress verification failed");
    });
    expect(failed).toBe(false);

    const absent = await resolveAsrtWindowsReady("ready", "absent", async () => {
      throw new Error("should not verify absent WFP");
    });
    expect(absent).toBe(false);
  });

  it("pins Windows filesystem ACL readiness to ASRT initialize fail-closed behavior", () => {
    const source = readAsrtSandboxManagerSource();
    expect(source).toContain("grantWindowsAcl({");
    expect(source).toContain("stampWindowsAcl({");
    expect(source).toContain("revokeWindowsAcl({ sandboxUserSid: sb, srtWin })");
    expect(source).toContain("restoreWindowsAcl({ sandboxUserSid: sb, srtWin })");
    expect(source).toContain("config = undefined;");
    expect(source).toContain("throw e;");
  });
});
