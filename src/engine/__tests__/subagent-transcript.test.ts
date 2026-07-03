import { describe, expect, it } from "vitest";
import { SubAgentTranscriptAccumulator } from "../subagent-transcript.js";
import type { ToolCallMeta } from "../../tools/executor.js";

function meta(over: Partial<ToolCallMeta> = {}): ToolCallMeta {
  return {
    groupId: "g1",
    toolUseId: "tu1",
    displayOrder: 0,
    source: "builtin",
    category: "read",
    ...over,
  };
}

describe("SubAgentTranscriptAccumulator", () => {
  it("builds a tool_group entry from tool start + end (shared ChatEntry model)", () => {
    const acc = new SubAgentTranscriptAccumulator();
    acc.onToolStart("read_file", { path: "/tmp/x" }, meta());
    let snap = acc.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].kind).toBe("tool_group");

    acc.onToolEnd("read_file", "file body", false, meta(), undefined, 12);
    snap = acc.snapshot();
    const group = snap[0];
    if (group.kind !== "tool_group") throw new Error("expected tool_group");
    expect(group.tools[0].status).toBe("done");
    expect(group.tools[0].result).toBe("file body");
    expect(group.tools[0].durationMs).toBe(12);
  });

  it("DLP-masks child tool RESULTS before they enter the transcript", () => {
    const acc = new SubAgentTranscriptAccumulator();
    acc.onToolStart("read_file", { path: "/tmp/x" }, meta());
    // A PII value (email) that maskSensitiveData redacts — this is the NEW
    // persisted/forwarded surface, so leaking here would be a DLP hole.
    acc.onToolEnd("read_file", "contact: secret.person@example.com", false, meta(), undefined, 5);
    const group = acc.snapshot()[0];
    if (group.kind !== "tool_group") throw new Error("expected tool_group");
    // audit/dlp-filter masks the email local-part to `***@…` — the raw PII
    // must not survive.
    expect(group.tools[0].result).not.toContain("secret.person@example.com");
    expect(group.tools[0].result).toContain("***@example.com");
  });

  it("DLP-masks reasoning + assistant text from a child round", () => {
    const acc = new SubAgentTranscriptAccumulator();
    acc.onAssistantRound("email me at leak@example.com", "reply to leak2@example.com");
    const snap = acc.snapshot();
    const joined = JSON.stringify(snap);
    expect(joined).not.toContain("leak@example.com");
    expect(joined).not.toContain("leak2@example.com");
    expect(joined).toContain("***@example.com");
  });

  it("folds a completed assistant round into reasoning + assistant entries", () => {
    const acc = new SubAgentTranscriptAccumulator();
    acc.onAssistantRound("thinking about it", "final answer");
    const snap = acc.snapshot();
    const kinds = snap.map((e) => e.kind);
    expect(kinds).toContain("reasoning");
    expect(kinds).toContain("assistant");
    const assistant = snap.find((e) => e.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    expect(assistant.text).toBe("final answer");
    expect(assistant.streaming).toBe(false);
  });

  it("adds a permission_review entry", () => {
    const acc = new SubAgentTranscriptAccumulator();
    acc.onPermissionReview({
      status: "reviewing",
      toolName: "write_file",
      groupId: "g1",
      toolUseId: "tu2",
      displayOrder: 1,
      toolCategory: "write",
      source: "builtin",
    });
    const snap = acc.snapshot();
    expect(snap.some((e) => e.kind === "permission_review")).toBe(true);
  });

  it("snapshot is idempotent-replaceable — later reads reflect accumulated state", () => {
    const acc = new SubAgentTranscriptAccumulator();
    acc.onToolStart("read_file", {}, meta());
    const first = acc.snapshot();
    acc.onAssistantRound("", "done");
    const second = acc.snapshot();
    expect(second.length).toBeGreaterThan(first.length);
  });
});
