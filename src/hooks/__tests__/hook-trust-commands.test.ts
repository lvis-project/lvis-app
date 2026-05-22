import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acceptHookTrust,
  disableHookTrust,
  listHookTrustState,
  rejectHookTrust,
} from "../hook-trust-commands.js";
import { wireHookSystem } from "../../boot/steps/hook-system-wiring.js";
import { writeExecutableHook } from "./test-helpers.js";

let tmpDir: string;
let hooksDir: string;
let disabledDir: string;
let lockfilePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "permission-policy-hook-commands-"));
  hooksDir = join(tmpDir, "hooks");
  disabledDir = join(hooksDir, ".disabled");
  lockfilePath = join(hooksDir, ".lockfile.json");
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function opts() {
  return { hooksDir, disabledDir, lockfilePath };
}

describe("hook trust slash command operations", () => {
  it("accepts a boot-quarantined hook and updates runtime trust", async () => {
    writeExecutableHook(hooksDir, "pre-demo.sh");
    const boot = await wireHookSystem(opts());
    expect(boot.manager.size()).toBe(0);
    expect(existsSync(join(disabledDir, "pre-demo.sh"))).toBe(true);

    const accepted = await acceptHookTrust("pre-demo.sh", {
      ...opts(),
      manager: boot.manager,
    });

    expect(accepted).toMatchObject({ ok: true, verb: "accept" });
    expect(boot.manager.size()).toBe(1);
    expect(existsSync(join(hooksDir, "pre-demo.sh"))).toBe(true);
    const listed = listHookTrustState(opts());
    expect(listed.active).toMatchObject([{ fileName: "pre-demo.sh", state: "trusted" }]);
  });

  it("disables an accepted hook and removes it from runtime trust", async () => {
    writeExecutableHook(hooksDir, "perm-demo.sh");
    const boot = await wireHookSystem({
      ...opts(),
      promptDispatcher: {
        prompt: async () => [{ fileName: "perm-demo.sh", trust: true }],
      },
    });
    expect(boot.manager.size()).toBe(1);

    const disabled = await disableHookTrust("perm-demo.sh", {
      ...opts(),
      manager: boot.manager,
    });

    expect(disabled).toMatchObject({ ok: true, verb: "disable" });
    expect(boot.manager.size()).toBe(0);
    expect(existsSync(join(disabledDir, "perm-demo.sh"))).toBe(true);
  });

  it("rejects hook names with path separators", async () => {
    await expect(acceptHookTrust("../pre-demo.sh", opts())).resolves.toMatchObject({
      ok: false,
    });
  });

  it("reject permanently removes a quarantined hook from .disabled/", async () => {
    writeExecutableHook(hooksDir, "pre-quarantined.sh");
    const boot = await wireHookSystem(opts());
    expect(boot.manager.size()).toBe(0);
    expect(existsSync(join(disabledDir, "pre-quarantined.sh"))).toBe(true);

    const result = await rejectHookTrust("pre-quarantined.sh", {
      ...opts(),
      manager: boot.manager,
    });

    expect(result).toMatchObject({ ok: true, verb: "reject" });
    expect(existsSync(join(disabledDir, "pre-quarantined.sh"))).toBe(false);
    expect(existsSync(join(hooksDir, "pre-quarantined.sh"))).toBe(false);
  });

  it("reject refuses an active (trusted) hook — must disable first", async () => {
    writeExecutableHook(hooksDir, "perm-active.sh");
    const boot = await wireHookSystem({
      ...opts(),
      promptDispatcher: {
        prompt: async () => [{ fileName: "perm-active.sh", trust: true }],
      },
    });
    expect(boot.manager.size()).toBe(1);

    const result = await rejectHookTrust("perm-active.sh", {
      ...opts(),
      manager: boot.manager,
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/disable it first/);
    expect(existsSync(join(hooksDir, "perm-active.sh"))).toBe(true);
    expect(boot.manager.size()).toBe(1);
  });

  it("reject of unknown hook name returns not-found", async () => {
    await wireHookSystem(opts());
    const result = await rejectHookTrust("pre-nope.sh", opts());
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/not found/);
  });

  it("reject rejects hook names with path separators", async () => {
    await expect(rejectHookTrust("../escape.sh", opts())).resolves.toMatchObject({
      ok: false,
    });
  });
});
