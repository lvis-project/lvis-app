/**
 * #811 command-hooks milestone — `hooks.json` TOFU trust unit tests.
 *
 * Spec ref: docs/architecture/hook-runtime-expansion-design.md §6.1 / §9 / §10.
 *
 * SECURITY focus: a new or changed `hooks.json` is QUARANTINED (its commands
 * NEVER load) until `/permission hooks accept hooks.json`. Editing a referenced
 * local script ALSO re-quarantines (composite trust hash). Binary-only commands
 * are rejected at parse and contribute no runnable entries.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHookConfig,
  syntheticConfigHook,
  resolveScriptAnchor,
  HOOKS_CONFIG_FILENAME,
} from "../hook-config-trust.js";
import { runHookTrustWorkflow } from "../hook-trust-prompt.js";
import { acceptHookTrust, listHookTrustState } from "../hook-trust-commands.js";
import { wireHookSystem } from "../../boot/steps/hook-system-wiring.js";
import { writeJsonConfig } from "./test-helpers.js";

let tmpDir: string;
let hooksDir: string;
let disabledDir: string;
let lockfilePath: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hook-config-trust-"));
  hooksDir = join(tmpDir, "hooks");
  disabledDir = join(hooksDir, ".disabled");
  lockfilePath = join(hooksDir, ".lockfile.json");
  configPath = join(hooksDir, HOOKS_CONFIG_FILENAME);
  mkdirSync(hooksDir, { recursive: true });
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function opts() {
  return { hooksDir, disabledDir, lockfilePath };
}

function writeScript(name: string, body: string): string {
  const p = join(hooksDir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

const ALLOW_CONFIG = {
  version: 1,
  hooks: {
    PreToolUse: [
      { hooks: [{ type: "command", command: "./policy.sh" }] },
    ],
  },
};

describe("loadHookConfig — composite trust hash", () => {
  it("returns exists:false for a missing config (byte-identical to no config)", () => {
    const loaded = loadHookConfig(configPath);
    expect(loaded.exists).toBe(false);
    expect(loaded.entries).toEqual([]);
    expect(loaded.trustHash).toBeNull();
    expect(syntheticConfigHook(loaded)).toBeNull();
  });

  it("hash changes when hooks.json bytes change", () => {
    writeJsonConfig(configPath, ALLOW_CONFIG);
    const h1 = loadHookConfig(configPath).trustHash;
    writeJsonConfig(configPath, { ...ALLOW_CONFIG, version: 2 });
    const h2 = loadHookConfig(configPath).trustHash;
    expect(h1).not.toBeNull();
    expect(h1).not.toBe(h2);
  });

  it("hash changes when a REFERENCED local script changes (composite)", () => {
    writeScript("policy.sh", "#!/bin/sh\necho '{\"action\":\"allow\",\"reason\":\"v1\"}'");
    writeJsonConfig(configPath, {
      version: 1,
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: join(hooksDir, "policy.sh") }] }] },
    });
    const h1 = loadHookConfig(configPath).trustHash;
    // hooks.json bytes unchanged; only the referenced script changes.
    writeScript("policy.sh", "#!/bin/sh\necho '{\"action\":\"deny\",\"reason\":\"v2-malicious\"}'");
    const h2 = loadHookConfig(configPath).trustHash;
    expect(h1).not.toBe(h2);
  });

  it("binary-only commands are rejected at parse → no runnable entries", () => {
    writeJsonConfig(configPath, {
      version: 1,
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "curl https://evil/x" }] }] },
    });
    const loaded = loadHookConfig(configPath);
    expect(loaded.entries).toHaveLength(0);
    expect(loaded.errors.length).toBeGreaterThan(0);
    expect(loaded.errors[0]).toContain("PATH-binary");
  });

  it("resolveScriptAnchor finds the local anchor (or null for binary-only)", () => {
    expect(resolveScriptAnchor(["./a.sh"])).toMatch(/a\.sh$/);
    expect(resolveScriptAnchor(["python3", "./p.py"])).toMatch(/p\.py$/);
    expect(resolveScriptAnchor(["curl", "https://x"])).toBeNull();
  });
});

describe("hooks.json TOFU diff — quarantine by default", () => {
  it("a NEW hooks.json is quarantined (strict-deny, no dispatcher)", async () => {
    writeJsonConfig(configPath, ALLOW_CONFIG);
    const result = await runHookTrustWorkflow(opts());
    // The synthetic config hook was quarantined; commands never load.
    expect(result.disabledHooks.map((h) => h.fileName)).toContain(HOOKS_CONFIG_FILENAME);
    expect(result.trustedConfigEntries).toEqual([]);
    // hooks.json was moved to .disabled/.
    expect(existsSync(join(disabledDir, HOOKS_CONFIG_FILENAME))).toBe(true);
    expect(existsSync(configPath)).toBe(false);
  });

  it("a trusted (dispatcher-approved) hooks.json loads its command entries", async () => {
    writeJsonConfig(configPath, ALLOW_CONFIG);
    const result = await runHookTrustWorkflow({
      ...opts(),
      promptDispatcher: { prompt: async (d) => d.map((x) => ({ fileName: x.hook.fileName, trust: true })) },
    });
    expect(result.trustedHooks.map((h) => h.fileName)).toContain(HOOKS_CONFIG_FILENAME);
    expect(result.trustedConfigEntries).toHaveLength(1);
    expect(result.trustedConfigEntries[0].command).toEqual(["./policy.sh"]);
    expect(existsSync(configPath)).toBe(true);
  });

  it("a CHANGED hooks.json on a later boot is re-quarantined", async () => {
    writeJsonConfig(configPath, ALLOW_CONFIG);
    // First boot: trust it.
    await runHookTrustWorkflow({
      ...opts(),
      promptDispatcher: { prompt: async (d) => d.map((x) => ({ fileName: x.hook.fileName, trust: true })) },
    });
    // Mutate the config.
    writeJsonConfig(configPath, { ...ALLOW_CONFIG, version: 2 });
    // Second boot: strict-deny → re-quarantine, commands stop loading.
    const seen: string[] = [];
    const result = await runHookTrustWorkflow({
      ...opts(),
      promptDispatcher: {
        prompt: async (d) => {
          for (const x of d) seen.push(`${x.state}:${x.hook.fileName}`);
          return d.map((x) => ({ fileName: x.hook.fileName, trust: false }));
        },
      },
    });
    expect(seen).toContain(`changed:${HOOKS_CONFIG_FILENAME}`);
    expect(result.disabledHooks.map((h) => h.fileName)).toContain(HOOKS_CONFIG_FILENAME);
    expect(result.trustedConfigEntries).toEqual([]);
  });
});

describe("hooks.json /permission hooks accept restores + loads", () => {
  it("accept restores a quarantined hooks.json and the manager loads its entries", async () => {
    writeJsonConfig(configPath, ALLOW_CONFIG);
    const boot = await wireHookSystem(opts());
    // Quarantined → registry empty.
    expect(boot.manager.size()).toBe(0);
    expect(existsSync(join(disabledDir, HOOKS_CONFIG_FILENAME))).toBe(true);

    const accepted = await acceptHookTrust(HOOKS_CONFIG_FILENAME, {
      ...opts(),
      manager: boot.manager,
    });
    expect(accepted).toMatchObject({ ok: true, verb: "accept" });
    // hooks.json restored to the active dir AND its command entry now loads.
    expect(existsSync(configPath)).toBe(true);
    expect(boot.manager.size()).toBe(1);

    const listed = listHookTrustState(opts());
    const configRow = listed.active.find((r) => r.fileName === HOOKS_CONFIG_FILENAME);
    expect(configRow?.state).toBe("trusted");
    // STEP 6 — additive trust-review fields populated.
    expect(configRow?.source).toBe("config");
    expect(configRow?.entryCount).toBe(1);
    expect(configRow?.entries?.[0]).toMatchObject({ event: "pre", command: "./policy.sh" });
  });

  it("accept rejects an identity that is not the exact config literal (no traversal)", async () => {
    await expect(
      acceptHookTrust("../hooks.json", opts()),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      acceptHookTrust("hooks.json.bak", opts()),
    ).resolves.toMatchObject({ ok: false });
  });
});
