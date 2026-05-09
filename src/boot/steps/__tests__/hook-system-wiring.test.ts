/**
 * Q12 P4 Area B — hook-system boot wiring tests.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 6.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireHookSystem } from "../hook-system-wiring.js";
import type { HookDiff } from "../../../hooks/hook-discovery.js";

let tmpDir: string;
let hooksDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "q12-p4-hsw-"));
  hooksDir = join(tmpDir, "hooks");
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function writeHook(name: string, body: string): void {
  mkdirSync(hooksDir, { recursive: true });
  const path = join(hooksDir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o700);
}

describe("Q12 P4 wireHookSystem", () => {
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
    writeHook("pre-good.sh", "#!/bin/sh\necho '{}'");
    writeHook("post-bad.sh", "#!/bin/sh\nexit 1");
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

  it("strict-deny when neither dispatcher nor renderer awaiter is provided", async () => {
    writeHook("pre-untrusted.sh", "#!/bin/sh\nexit 0");
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

  it("uses awaitRendererDecisions when supplied (production IPC bridge)", async () => {
    writeHook("pre-x.sh", "#!/bin/sh\nexit 0");
    const result = await wireHookSystem({
      hooksDir,
      lockfilePath: join(hooksDir, ".lockfile.json"),
      disabledDir: join(hooksDir, ".disabled"),
      awaitRendererDecisions: async (diff) =>
        diff.map((d) => ({ fileName: d.hook.fileName, trust: true })),
    });
    expect(result.manager.size()).toBe(1);
    expect(result.trust.trustedHooks.map((h) => h.fileName)).toEqual(["pre-x.sh"]);
  });

  it("strict-deny when renderer awaiter throws", async () => {
    writeHook("pre-x.sh", "#!/bin/sh\nexit 0");
    const result = await wireHookSystem({
      hooksDir,
      lockfilePath: join(hooksDir, ".lockfile.json"),
      disabledDir: join(hooksDir, ".disabled"),
      awaitRendererDecisions: async () => {
        throw new Error("UI unavailable");
      },
    });
    expect(result.manager.size()).toBe(0);
    expect(result.trust.disabledHooks.map((h) => h.fileName)).toEqual(["pre-x.sh"]);
  });
});
