/**
 * FakeSandbox unit tests — proposal §3.2 + Risk R5.
 *
 * Invariants:
 *   - resolve never touches network/fs/plugins
 *   - unknown tool → ok:false (no throw bubbling to consumer)
 *   - empty fakeResult → ok:false
 *   - real plugin tool names DO NOT route here unless explicitly passed
 */
import { describe, it, expect } from "vitest";
import { FakeSandbox } from "../fake-sandbox.js";
import type { ScriptedToolCall } from "../types.js";

describe("FakeSandbox", () => {
  it("resolves a well-formed tool call", async () => {
    const sandbox = new FakeSandbox();
    const call: ScriptedToolCall = {
      toolName: "meeting_list",
      labelKo: "최근 회의",
      fakeResultKo: "3건 발견",
    };
    const result = await sandbox.resolve(call);
    expect(result).toEqual({ ok: true, result: "3건 발견" });
  });

  it("returns unknown-tool when toolName is missing", async () => {
    const sandbox = new FakeSandbox();
    const result = await sandbox.resolve({
      toolName: "",
      labelKo: "x",
      fakeResultKo: "y",
    });
    expect(result).toEqual({ ok: false, error: "unknown-tool" });
  });

  it("returns empty-result when fakeResultKo is missing", async () => {
    const sandbox = new FakeSandbox();
    const result = await sandbox.resolve({
      toolName: "meeting_list",
      labelKo: "x",
      fakeResultKo: "",
    });
    expect(result).toEqual({ ok: false, error: "empty-result" });
  });

  it("does not expose any external surface (smoke check)", () => {
    const sandbox = new FakeSandbox();
    // Public surface limited to `resolve`. If a new method appears that
    // could touch the outside world it should be reviewed against the
    // trust boundary in the proposal.
    const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(sandbox));
    expect(keys.sort()).toEqual(["constructor", "resolve"].sort());
  });
});
