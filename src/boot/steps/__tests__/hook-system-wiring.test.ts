/**
 * Permission policy — hook-system boot wiring tests.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 6.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireHookSystem } from "../hook-system-wiring.js";
import type { HookDiff } from "../../../hooks/hook-discovery.js";
import { writeExecutableHook } from "../../../hooks/__tests__/test-helpers.js";

let tmpDir: string;
let hooksDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "permission-hooks-"));
  hooksDir = join(tmpDir, "hooks");
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("wireHookSystem permission hook policy", () => {
  it("returns a manager + trust result on empty directory", async () => {
    const result = await wireHookSystem({
      hooksDir,
      lockfilePath: join(hooksDir, ".lockfile.json"),
      disabledDir: join(hooksDir, ".disabled"),
    });
    expect(result.manager.size()).toBe(0);
    expect(result.trust.trustedHooks).toEqual([]);
    expect(existsSync(hooksDir)).toBe(true);
  });

  it("seeds the manager with trusted hooks from the dispatcher", async () => {
    writeExecutableHook(hooksDir, "pre-good.sh", "#!/bin/sh\necho '{}'");
    writeExecutableHook(hooksDir, "post-bad.sh", "#!/bin/sh\nexit 1");
    const result = await wireHookSystem({
      hooksDir,
      lockfilePath: join(hooksDir, ".lockfile.json"),
      disabledDir: join(hooksDir, ".disabled"),
      promptDispatcher: {
        prompt: async (diff: HookDiff[]) =>
          diff.map((d) => ({
            fileName: d.hook.fileName,
            trust: d.hook.fileName === "pre-good.sh",
          })),
      },
    });
    expect(result.manager.size()).toBe(1);
    expect(result.trust.trustedHooks.map((h) => h.fileName)).toEqual([
      "pre-good.sh",
    ]);
    expect(result.trust.disabledHooks.map((h) => h.fileName)).toEqual([
      "post-bad.sh",
    ]);
    // Disabled file moved to .disabled/
    const disabledFiles = readdirSync(join(hooksDir, ".disabled"));
    expect(disabledFiles).toContain("post-bad.sh");
  });

  it("strict-deny when no test dispatcher is provided", async () => {
    writeExecutableHook(hooksDir, "pre-untrusted.sh", "#!/bin/sh\nexit 0");
    const result = await wireHookSystem({
      hooksDir,
      lockfilePath: join(hooksDir, ".lockfile.json"),
      disabledDir: join(hooksDir, ".disabled"),
    });
    expect(result.manager.size()).toBe(0);
    expect(result.trust.disabledHooks.map((h) => h.fileName)).toEqual([
      "pre-untrusted.sh",
    ]);
  });

  it("emits hook.quarantined audit entries for boot-time quarantine", async () => {
    writeExecutableHook(hooksDir, "pre-untrusted.sh", "#!/bin/sh\nexit 0");
    const auditLogger = {
      log: vi.fn(),
      isPermissionAuditChainReady: vi.fn(() => true),
      appendPermissionAuditEntry: vi.fn(async (entry) => ({ ...entry, prevHash: "h" })),
    };

    await wireHookSystem({
      hooksDir,
      lockfilePath: join(hooksDir, ".lockfile.json"),
      disabledDir: join(hooksDir, ".disabled"),
      auditLogger,
    });

    expect(auditLogger.log).toHaveBeenCalledTimes(1);
    expect(auditLogger.appendPermissionAuditEntry).toHaveBeenCalledTimes(1);
    const entry = auditLogger.log.mock.calls[0][0];
    expect(entry.type).toBe("warn");
    expect(entry.toolCalls).toEqual([
      { name: "hook_trust_boot", isError: false, trust: "high" },
    ]);
    expect(JSON.parse(entry.input)).toEqual(
      expect.objectContaining({
        kind: "hook.quarantined",
        fileName: "pre-untrusted.sh",
        hookType: "pre",
        state: "new",
      }),
    );
    expect(auditLogger.appendPermissionAuditEntry.mock.calls[0][0]).toMatchObject({
      decision: "deny",
      tool: "hook_trust_boot",
      source: "builtin",
      category: "meta",
      denyReasons: [
        expect.objectContaining({
          layer: 6,
          reason: "hook.quarantined:pre-untrusted.sh:new",
          source: "hook-trust-workflow",
        }),
      ],
    });
  });
});
