/**
 * Permission policy P4 Area B — script-hook manager tests.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 6.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  ScriptHookManager,
  dlpRedactInput,
  type HookDispatchPayload,
} from "../script-hook-manager.js";
import { fixtureHook as buildFixtureHook } from "./test-helpers.js";

const FIXTURE_ROOT = resolve(__dirname, "..", "..", "..", "test", "fixtures", "hooks");
const WINDOWS_SHELL_TIMEOUT_MS = 20_000;
const shellIntegrationOptions =
  process.platform === "win32" ? { timeoutMs: WINDOWS_SHELL_TIMEOUT_MS } : undefined;

const hookFixture = (
  fileName: string,
  type: "pre" | "post" | "perm" = "pre",
): ReturnType<typeof buildFixtureHook> => buildFixtureHook(FIXTURE_ROOT, fileName, type);

const basePayload: HookDispatchPayload = {
  toolName: "fs_write",
  source: "builtin",
  category: "write",
  input: { path: "/tmp/x" },
  sessionId: "sess-1",
  trustOrigin: "user-keyboard",
};

describe("Permission policy P4 ScriptHookManager", () => {
  it("returns allow + zero hooks when nothing is loaded", async () => {
    const m = new ScriptHookManager();
    const out = await m.runPreToolUse(basePayload);
    expect(out.decision).toBe("allow");
    expect(out.results).toEqual([]);
    expect(m.size()).toBe(0);
  });

  it("filters hooks by type — only pre runs in runPreToolUse", async () => {
    const m = new ScriptHookManager();
    m.setTrustedHooks([
      hookFixture("pre-allow.sh", "pre"),
      hookFixture("post-observe.sh", "post"),
      hookFixture("perm-strict.sh", "perm"),
    ]);
    const pre = await m.runPreToolUse(basePayload, shellIntegrationOptions);
    expect(pre.decision).toBe("allow");
    expect(pre.results).toHaveLength(1);
    expect(pre.results[0].hookType).toBe("pre");
  });

  it("hook deny wins over upstream allow signal (deny precedence)", async () => {
    const m = new ScriptHookManager();
    m.setTrustedHooks([hookFixture("pre-deny.sh", "pre")]);
    const out = await m.runPreToolUse(basePayload, shellIntegrationOptions);
    expect(out.decision).toBe("deny");
  });

  it("post hooks observe — chain still returns allow when all allow", async () => {
    const m = new ScriptHookManager();
    m.setTrustedHooks([hookFixture("post-observe.sh", "post")]);
    const out = await m.runPostToolUse({
      ...basePayload,
      toolOutput: "tool ran",
      isError: false,
    }, shellIntegrationOptions);
    expect(out.decision).toBe("allow");
    expect(out.results).toHaveLength(1);
    expect(out.results[0].hookType).toBe("post");
  });

  it("perm hooks gate ApprovalRequest rounds", async () => {
    const m = new ScriptHookManager();
    m.setTrustedHooks([hookFixture("perm-strict.sh", "perm")]);
    const out = await m.runPermissionRequest(basePayload, shellIntegrationOptions);
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("strict perm policy");
  });
});

describe("Permission policy P4 dlpRedactInput", () => {
  it("masks email + phone in string fields", () => {
    const out = dlpRedactInput({
      to: "ken@lvis.example.com",
      phone: "010-1234-5678",
      count: 3,
    });
    expect(out.to).toContain("[REDACTED:EMAIL]");
    expect(out.phone).toContain("[REDACTED:PHONE]");
    expect(out.count).toBe(3);
  });

  it("walks string array elements", () => {
    const out = dlpRedactInput({
      ccs: ["alice@x.com", "not-an-email"],
    });
    expect((out.ccs as string[])[0]).toContain("[REDACTED:EMAIL]");
    expect((out.ccs as string[])[1]).toBe("not-an-email");
  });

  it("passes through booleans + nested objects unchanged", () => {
    const nested = { deep: { ssn: "123456-1234567" } };
    const out = dlpRedactInput({ enabled: true, nested });
    expect(out.enabled).toBe(true);
    // Nested objects intentionally not walked — caller redacts at the
    // call boundary, never trusts deep recursion.
    expect(out.nested).toBe(nested);
  });
});
