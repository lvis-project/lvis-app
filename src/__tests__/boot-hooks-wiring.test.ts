/**
 * Permission policy boot hook wiring regression (#811 command-hooks milestone).
 *
 * NEW invariant (replaces the pre-#811 "hooks.json is never loaded" rule):
 * `hooks.json` IS loaded by `wireHookSystem`, but ONLY through the SAME TOFU
 * quarantine gate as `.sh` files. An untrusted or changed `hooks.json` stays
 * quarantined (its commands NEVER run); a trusted, unchanged one loads its
 * command entries into the runtime registry. There is no path by which an
 * un-trusted config spawns a command.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHookRunner } from "../boot/conversation.js";
import { wireHookSystem } from "../boot/steps/hook-system-wiring.js";
import { acceptHookTrust } from "../hooks/hook-trust-commands.js";
import { HOOKS_CONFIG_FILENAME } from "../hooks/hook-config-trust.js";
import { writeJsonConfig } from "../hooks/__tests__/test-helpers.js";

describe("boot hook runner wiring", () => {
  it("creates an in-process HookRunner with no external hook surface", async () => {
    const runner = createHookRunner();

    const pre = await runner.runPreHooks({
      toolName: "bash",
      toolInput: { command: "ls" },
    });
    const post = await runner.runPostHooks({
      toolName: "bash",
      toolInput: { command: "ls" },
      toolOutput: "ok",
      isError: false,
    });

    expect(runner.preHookCount).toBe(0);
    expect(runner.postHookCount).toBe(0);
    expect(pre).toMatchObject({ action: "allow" });
    expect(post).toBeUndefined();
  });
});

describe("boot wireHookSystem — hooks.json rides the TOFU quarantine gate (#811)", () => {
  let tmpDir: string;
  let hooksDir: string;
  let disabledDir: string;
  let lockfilePath: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "boot-hooks-wiring-"));
    hooksDir = join(tmpDir, "hooks");
    disabledDir = join(hooksDir, ".disabled");
    lockfilePath = join(hooksDir, ".lockfile.json");
    configPath = join(hooksDir, HOOKS_CONFIG_FILENAME);
    mkdirSync(hooksDir, { recursive: true });
    // Referenced local-script the config points at. Named WITHOUT a
    // pre-/post-/perm- prefix so `discoverHooks` ignores it — it is only a
    // command target, not a standalone `.sh` hook.
    const p = join(hooksDir, "policy.sh");
    writeFileSync(p, "#!/bin/sh\necho '{\"action\":\"allow\",\"reason\":\"ok\"}'");
    chmodSync(p, 0o755);
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function opts() {
    return { hooksDir, disabledDir, lockfilePath };
  }

  const CONFIG = {
    version: 1,
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "./policy.sh" }] }] },
  };

  it("no hooks.json ⇒ empty registry (back-compat — behavior identical to today)", async () => {
    const boot = await wireHookSystem(opts());
    expect(boot.manager.size()).toBe(0);
    expect(boot.trust.trustedConfigEntries).toEqual([]);
  });

  it("an UNTRUSTED hooks.json is loaded ONLY into quarantine — never into the registry", async () => {
    writeJsonConfig(configPath, CONFIG);
    const boot = await wireHookSystem(opts());
    // Production strict-deny: the config IS discovered but quarantined.
    expect(boot.manager.size()).toBe(0);
    expect(boot.trust.trustedConfigEntries).toEqual([]);
    expect(boot.trust.disabledHooks.map((h) => h.fileName)).toContain(HOOKS_CONFIG_FILENAME);
    // Moved to .disabled/ — its commands cannot run.
    expect(existsSync(join(disabledDir, HOOKS_CONFIG_FILENAME))).toBe(true);
    expect(existsSync(configPath)).toBe(false);
  });

  it("a TRUSTED hooks.json loads its command entries into the registry", async () => {
    writeJsonConfig(configPath, CONFIG);
    // First boot quarantines; user accepts; second boot loads.
    const firstBoot = await wireHookSystem(opts());
    expect(firstBoot.manager.size()).toBe(0);

    const accepted = await acceptHookTrust(HOOKS_CONFIG_FILENAME, {
      ...opts(),
      manager: firstBoot.manager,
    });
    expect(accepted).toMatchObject({ ok: true });

    // A fresh boot now finds the config trusted+unchanged and loads it.
    const secondBoot = await wireHookSystem(opts());
    expect(secondBoot.trust.trustedConfigEntries).toHaveLength(1);
    expect(secondBoot.manager.size()).toBe(1);
  });

  it("a CHANGED hooks.json after trust is re-quarantined — commands stop running", async () => {
    writeJsonConfig(configPath, CONFIG);
    const boot1 = await wireHookSystem(opts());
    await acceptHookTrust(HOOKS_CONFIG_FILENAME, { ...opts(), manager: boot1.manager });
    const boot2 = await wireHookSystem(opts());
    expect(boot2.manager.size()).toBe(1);

    // Tamper with the trusted config.
    writeJsonConfig(configPath, { ...CONFIG, version: 999 });
    const boot3 = await wireHookSystem(opts());
    // Re-quarantined: registry empty again, NO commands load from the changed config.
    expect(boot3.manager.size()).toBe(0);
    expect(boot3.trust.trustedConfigEntries).toEqual([]);
    expect(existsSync(join(disabledDir, HOOKS_CONFIG_FILENAME))).toBe(true);
  });
});
