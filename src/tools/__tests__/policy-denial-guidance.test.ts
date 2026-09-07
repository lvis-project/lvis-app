/**
 * Host policy refusals must read as refusals, not as failures.
 *
 * All four bracketed block kinds — `Directory policy blocked`, `Shell path
 * policy blocked`, `Bash AST blocked`, `Sensitive path blocked` — reach the
 * model as an ordinary `isError` tool result, the same shape a command that
 * merely failed produces. In an 89-task agentic run they were 458 of 770 tool
 * errors and consumed 21.9% of all rounds, because the only response a plain
 * failure invites is "rewrite the command and try again", which a policy
 * decision never rewards.
 *
 * These tests pin the three things the shared guidance has to carry: WHAT was
 * judged and under which rule, whether a retry can change the answer, and which
 * directories a call could legitimately target instead.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { buildPolicyDenialGuidance } from "../invocation-runner.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ToolPermissionContext } from "../executor.js";

describe("buildPolicyDenialGuidance", () => {
  it("names the judged operand and the rule that judged it", () => {
    const guidance = buildPolicyDenialGuidance({
      rule: "shell-path-policy/sandbox-boundary",
      operand: "/data/source",
      retry: "never",
      allowedDirectories: ["/work"],
    });
    expect(guidance).toContain("/data/source");
    expect(guidance).toContain("shell-path-policy/sandbox-boundary");
  });

  it("falls back to naming only the rule when no operand was judged", () => {
    // The bash AST layer refuses a command SHAPE, so there is no single token
    // to point at; the message must still say which rule spoke.
    const guidance = buildPolicyDenialGuidance({
      rule: "bash-ast/recursive-delete",
      retry: "never",
      allowedDirectories: ["/work"],
    });
    expect(guidance).toContain("bash-ast/recursive-delete");
  });

  it("distinguishes a decision no retry can change from one an authorization can", () => {
    const base = { rule: "r", operand: "/x", allowedDirectories: ["/work"] } as const;
    const never = buildPolicyDenialGuidance({ ...base, retry: "never" });
    const grant = buildPolicyDenialGuidance({ ...base, retry: "grant" });
    expect(never).not.toEqual(grant);
  });

  it("lists the authorized directories a call could target instead", () => {
    const guidance = buildPolicyDenialGuidance({
      rule: "r",
      operand: "/x",
      retry: "grant",
      allowedDirectories: ["/work", "/scratch"],
    });
    expect(guidance).toContain("/work");
    expect(guidance).toContain("/scratch");
  });

  it("truncates a long grant list rather than enumerating all of it", () => {
    const directories = Array.from({ length: 12 }, (_, i) => `/d${i}`);
    const guidance = buildPolicyDenialGuidance({
      rule: "r",
      operand: "/x",
      retry: "grant",
      allowedDirectories: directories,
    });
    expect(guidance).toContain("/d0");
    expect(guidance).not.toContain("/d11");
    expect(guidance).toContain("(+4)");
  });

  it("says the filesystem root can never be authorized, so the model stops asking for it", () => {
    const withRoot = buildPolicyDenialGuidance({
      rule: "allowed-directories/not-grantable",
      operand: "/",
      retry: "never",
      allowedDirectories: ["/work"],
      filesystemRootReference: true,
    });
    const withoutRoot = buildPolicyDenialGuidance({
      rule: "allowed-directories/not-grantable",
      operand: "/other",
      retry: "never",
      allowedDirectories: ["/work"],
    });
    expect(withRoot.length).toBeGreaterThan(withoutRoot.length);
  });
});

/** A plugin tool carrying a shell command string, as the containment tests use. */
function makeCommandBearingTool(spy: { ran: boolean }): Tool {
  return createDynamicTool({
    name: "plugin_run_command",
    description: "A plugin tool whose argument carries a shell command string.",
    source: "plugin",
    pluginId: "p-denial-guidance",
    category: "read",
    pathFields: [],
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: { command: { type: "string" } } },
    execute: async () => {
      spy.ran = true;
      return { output: "ran", isError: false };
    },
  });
}

async function runUnattended(
  command: string,
): Promise<{ isError: boolean; content: string; ran: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "lvis-denial-guidance-"));
  try {
    const spy = { ran: false };
    const registry = new ToolRegistry();
    registry.register(makeCommandBearingTool(spy));
    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      undefined,
      undefined,
      undefined,
      () => true, // hostClassifiesRisk — the shipped default
    );
    // headless — nobody is there to answer a prompt, which is the mode the
    // measured run used and the one where a wrong retry costs the most rounds.
    const permissionContext: ToolPermissionContext = {
      trustOrigin: "user-keyboard",
      headless: true,
    };
    const results = await executor.executeAll(
      [{ id: "tu-denial-guidance", name: "plugin_run_command", input: { command } }],
      { sessionId: "sess-denial-guidance", permissionContext },
    );
    return {
      isError: results[0]!.is_error === true,
      content: String(results[0]!.content),
      ran: spy.ran,
    };
  } finally {
    await cleanupTmpDir(dir);
  }
}

describe("policy denials carry their guidance through to the tool result", () => {
  it("keeps the bracketed prefix a downstream parser keys on", async () => {
    const result = await runUnattended("cat $PROJECT_SECRET/file.txt");
    expect(result.isError).toBe(true);
    expect(result.ran).toBe(false);
    // The prefix is localized like the rest of the block message; the suite
    // runs in the Korean locale, so that is the form asserted here.
    expect(result.content).toContain("[Shell 경로 정책 차단]");
  });

  it("names the rule and the judged operand on a shell path refusal", async () => {
    const result = await runUnattended("cat $PROJECT_SECRET/file.txt");
    expect(result.content).toContain("shell-path-policy/invalid-path");
    expect(result.content).toContain("$PROJECT_SECRET/file.txt");
  });

  it("tells the model that the filesystem root can never be authorized", async () => {
    const result = await runUnattended("ls /");
    expect(result.isError).toBe(true);
    expect(result.ran).toBe(false);
    expect(result.content).toContain("[디렉토리 정책 차단]");
    expect(result.content).toContain("allowed-directories/not-grantable");
  });
});
