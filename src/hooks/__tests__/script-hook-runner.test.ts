/**
 * Permission policy P4 Area B — script-hook runner tests.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 6.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  parseHookStdout,
  runHookChain,
  runOneHookScript,
} from "../script-hook-runner.js";
import type { DiscoveredHook } from "../hook-discovery.js";
import type { ScriptHookStdin } from "../script-hook-types.js";

const FIXTURE_ROOT = resolve(__dirname, "..", "..", "..", "test", "fixtures", "hooks");
const WINDOWS_SHELL_TIMEOUT_MS = 20_000;
const shellIntegrationOptions =
  process.platform === "win32" ? { timeoutMs: WINDOWS_SHELL_TIMEOUT_MS } : undefined;

function fixtureHook(fileName: string, type: "pre" | "post" | "perm" = "pre"): DiscoveredHook {
  return {
    path: resolve(FIXTURE_ROOT, fileName),
    fileName,
    hookType: type,
    sha256: "test",
    size: 0,
  };
}

const samplePayload: ScriptHookStdin = {
  hookType: "pre",
  toolName: "fs_write",
  source: "builtin",
  category: "write",
  input: { path: "/tmp/x" },
  sessionId: "sess-1",
  trustOrigin: "user-keyboard",
};

describe("Permission policy P4 parseHookStdout", () => {
  it("parses {action:'allow', reason:'...'}", () => {
    expect(parseHookStdout('{"action":"allow","reason":"ok"}')).toEqual({
      action: "allow",
      reason: "ok",
    });
  });

  it("parses {action:'deny', reason:'...'}", () => {
    expect(parseHookStdout('{"action":"deny","reason":"nope"}')).toEqual({
      action: "deny",
      reason: "nope",
    });
  });

  it("returns null for malformed JSON", () => {
    expect(parseHookStdout("not json")).toBeNull();
    expect(parseHookStdout("")).toBeNull();
    expect(parseHookStdout("{}")).toBeNull();
    expect(parseHookStdout('{"action":"allow"}')).toBeNull(); // missing reason
  });

  it("rejects 'modify' (v1 deferred to hook-signing follow-up)", () => {
    expect(
      parseHookStdout('{"action":"modify","reason":"x","updatedInput":{}}'),
    ).toBeNull();
  });

  it("tolerates code-fence wrapping", () => {
    const wrapped = '```json\n{"action":"allow","reason":"ok"}\n```';
    expect(parseHookStdout(wrapped)).toEqual({ action: "allow", reason: "ok" });
  });

  it("truncates reason at 280 chars", () => {
    const long = "a".repeat(500);
    const out = parseHookStdout(`{"action":"deny","reason":"${long}"}`);
    expect(out?.reason.length).toBe(280);
  });
});

describe("Permission policy P4 runOneHookScript", () => {
  it("runs an allow-emitting hook and parses the verdict", async () => {
    const r = await runOneHookScript(fixtureHook("pre-allow.sh"), samplePayload, shellIntegrationOptions);
    expect(r.decision).toBe("allow");
    expect(r.reason).toContain("fixture allow");
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it("runs a deny-emitting hook and parses the verdict", async () => {
    const r = await runOneHookScript(fixtureHook("pre-deny.sh"), samplePayload, shellIntegrationOptions);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("fixture deny");
  });

  it("treats non-zero exit as deny (fail-safe)", async () => {
    const r = await runOneHookScript(fixtureHook("pre-exit-fail.sh"), samplePayload, shellIntegrationOptions);
    expect(r.decision).toBe("deny");
    expect(r.exitCode).toBe(7);
    expect(r.reason).toMatch(/exited non-zero/);
  });

  it("treats malformed stdout as deny", async () => {
    const r = await runOneHookScript(fixtureHook("pre-bad-json.sh"), samplePayload, shellIntegrationOptions);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/not valid/);
  });

  it("enforces timeout (deny on slow hook)", async () => {
    const r = await runOneHookScript(
      fixtureHook("pre-slow.sh"),
      samplePayload,
      { timeoutMs: 200 },
    );
    expect(r.decision).toBe("deny");
    expect(r.timedOut).toBe(true);
    expect(r.reason).toMatch(/timed out/);
  });

  it("propagates trustOrigin via env so origin-aware hooks gate by it", async () => {
    const userPayload: ScriptHookStdin = { ...samplePayload, trustOrigin: "user-keyboard" };
    const llmPayload: ScriptHookStdin = { ...samplePayload, trustOrigin: "llm-tool-arg" };
    const userR = await runOneHookScript(fixtureHook("pre-origin-aware.sh"), userPayload, shellIntegrationOptions);
    const llmR = await runOneHookScript(fixtureHook("pre-origin-aware.sh"), llmPayload, shellIntegrationOptions);
    expect(userR.decision).toBe("allow");
    expect(llmR.decision).toBe("deny");
    expect(llmR.reason).toContain("non-user origin");
  });

  it("round-trips wire-shape stdin to the hook script", async () => {
    const r = await runOneHookScript(fixtureHook("pre-roundtrip.sh"), samplePayload, shellIntegrationOptions);
    expect(r.decision).toBe("allow");
    // Stdout includes received-payload echo; just confirm the JSON parsed
    // without errors. The "reason" field comes from the {action,reason} part.
    expect(r.reason).toBe("roundtrip");
  });
});

describe("Permission policy P4 runHookChain", () => {
  it("returns allow when chain is empty", async () => {
    const r = await runHookChain([], samplePayload);
    expect(r.decision).toBe("allow");
    expect(r.results).toEqual([]);
  });

  it("returns allow when all hooks allow", async () => {
    const r = await runHookChain(
      [fixtureHook("pre-allow.sh"), fixtureHook("pre-allow.sh")],
      samplePayload,
      shellIntegrationOptions,
    );
    expect(r.decision).toBe("allow");
    expect(r.results).toHaveLength(2);
  });

  it("stops at the first deny (deny precedence + cycle save)", async () => {
    const r = await runHookChain(
      [fixtureHook("pre-allow.sh"), fixtureHook("pre-deny.sh"), fixtureHook("pre-allow.sh")],
      samplePayload,
      shellIntegrationOptions,
    );
    expect(r.decision).toBe("deny");
    // Only first 2 hooks ran
    expect(r.results).toHaveLength(2);
    expect(r.reason).toContain("pre-deny.sh");
  });
});
