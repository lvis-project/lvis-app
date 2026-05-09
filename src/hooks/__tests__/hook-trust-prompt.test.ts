/**
 * Q12 P4 Area B — TOFU workflow orchestrator tests.
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
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runHookTrustWorkflow,
  type TrustPromptDecision,
  type TrustPromptDispatcher,
} from "../hook-trust-prompt.js";
import type { LockfileShape } from "../hook-discovery.js";

let tmpDir: string;
let hooksDir: string;
let lockfilePath: string;
let disabledDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "q12-p4-tofu-"));
  hooksDir = join(tmpDir, "hooks");
  lockfilePath = join(hooksDir, ".lockfile.json");
  disabledDir = join(hooksDir, ".disabled");
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

function makeDispatcher(decisions: TrustPromptDecision[]): TrustPromptDispatcher {
  return { prompt: async () => decisions };
}

describe("Q12 P4 runHookTrustWorkflow", () => {
  it("creates the hooks directory when missing (atomic cutover, no warn)", async () => {
    const result = await runHookTrustWorkflow({ hooksDir, lockfilePath, disabledDir });
    expect(existsSync(hooksDir)).toBe(true);
    expect(result.trustedHooks).toEqual([]);
    expect(result.disabledHooks).toEqual([]);
    expect(result.lockfile).toBeNull();
  });

  it("fresh install with hooks present + dispatcher trusts all → lockfile written", async () => {
    writeHook("pre-allow.sh", "#!/bin/sh\necho '{}'");
    writeHook("post-x.sh", "#!/bin/sh\necho '{}'");
    const result = await runHookTrustWorkflow({
      hooksDir,
      lockfilePath,
      disabledDir,
      promptDispatcher: makeDispatcher([
        { fileName: "pre-allow.sh", trust: true },
        { fileName: "post-x.sh", trust: true },
      ]),
    });
    expect(result.trustedHooks).toHaveLength(2);
    expect(result.disabledHooks).toEqual([]);
    expect(result.lockfile).not.toBeNull();
    expect(result.lockfile!.hooks).toHaveLength(2);
    const onDisk = JSON.parse(readFileSync(lockfilePath, "utf-8")) as LockfileShape;
    expect(onDisk.hooks.map((h) => h.fileName).sort()).toEqual([
      "post-x.sh",
      "pre-allow.sh",
    ]);
  });

  it("rejected hooks → moved to .disabled/ + not in lockfile", async () => {
    writeHook("pre-bad.sh", "#!/bin/sh\nexit 1");
    writeHook("pre-good.sh", "#!/bin/sh\nexit 0");
    const result = await runHookTrustWorkflow({
      hooksDir,
      lockfilePath,
      disabledDir,
      promptDispatcher: makeDispatcher([
        { fileName: "pre-bad.sh", trust: false },
        { fileName: "pre-good.sh", trust: true },
      ]),
    });
    expect(result.disabledHooks.map((h) => h.fileName)).toEqual(["pre-bad.sh"]);
    expect(result.trustedHooks.map((h) => h.fileName)).toEqual(["pre-good.sh"]);
    // The bad hook lives under .disabled now
    const disabledFiles = readdirSync(disabledDir);
    expect(disabledFiles).toContain("pre-bad.sh");
    // The good hook is still in hooksDir
    expect(existsSync(join(hooksDir, "pre-good.sh"))).toBe(true);
    expect(existsSync(join(hooksDir, "pre-bad.sh"))).toBe(false);
  });

  it("changed-hash detection on subsequent boot", async () => {
    writeHook("pre-x.sh", "#!/bin/sh\necho 'v1'");
    // First run: trust the hook
    await runHookTrustWorkflow({
      hooksDir,
      lockfilePath,
      disabledDir,
      promptDispatcher: makeDispatcher([{ fileName: "pre-x.sh", trust: true }]),
    });
    // Mutate the hook
    writeHook("pre-x.sh", "#!/bin/sh\necho 'v2-malicious'");
    // Second run: dispatcher should be invoked because hash changed
    const seen: string[] = [];
    const result = await runHookTrustWorkflow({
      hooksDir,
      lockfilePath,
      disabledDir,
      promptDispatcher: {
        prompt: async (diff) => {
          for (const d of diff) seen.push(`${d.state}:${d.hook.fileName}`);
          return diff.map((d) => ({ fileName: d.hook.fileName, trust: false }));
        },
      },
    });
    expect(seen).toEqual(["changed:pre-x.sh"]);
    expect(result.disabledHooks.map((h) => h.fileName)).toEqual(["pre-x.sh"]);
  });

  it("trusted-then-still-trusted preserves acceptedAt across runs", async () => {
    writeHook("pre-keep.sh", "#!/bin/sh\necho 'stable'");
    const first = await runHookTrustWorkflow({
      hooksDir,
      lockfilePath,
      disabledDir,
      promptDispatcher: makeDispatcher([{ fileName: "pre-keep.sh", trust: true }]),
    });
    const firstAcceptedAt = first.lockfile!.hooks[0].acceptedAt;
    // Second run with no changes — should not re-prompt
    const second = await runHookTrustWorkflow({
      hooksDir,
      lockfilePath,
      disabledDir,
      promptDispatcher: {
        prompt: async () => {
          throw new Error("must not prompt for trusted+unchanged hook");
        },
      },
    });
    expect(second.trustedHooks.map((h) => h.fileName)).toEqual(["pre-keep.sh"]);
    // The lockfile is preserved — trust is sticky.
    const onDisk = JSON.parse(readFileSync(lockfilePath, "utf-8")) as LockfileShape;
    expect(onDisk.hooks[0].acceptedAt).toBe(firstAcceptedAt);
  });

  it("strict-deny when no dispatcher — auto-disables every untrusted hook", async () => {
    writeHook("pre-untrusted.sh", "#!/bin/sh\necho hi");
    const result = await runHookTrustWorkflow({ hooksDir, lockfilePath, disabledDir });
    expect(result.trustedHooks).toEqual([]);
    expect(result.disabledHooks.map((h) => h.fileName)).toEqual(["pre-untrusted.sh"]);
  });

  it("dispatcher throws → strict-deny applied (defense-in-depth)", async () => {
    writeHook("pre-x.sh", "#!/bin/sh\nexit 0");
    const result = await runHookTrustWorkflow({
      hooksDir,
      lockfilePath,
      disabledDir,
      promptDispatcher: {
        prompt: async () => {
          throw new Error("UI not available");
        },
      },
    });
    expect(result.disabledHooks.map((h) => h.fileName)).toEqual(["pre-x.sh"]);
  });
});
