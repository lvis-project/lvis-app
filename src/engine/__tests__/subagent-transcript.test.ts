import { describe, expect, it, vi } from "vitest";
import { SubAgentTranscriptAccumulator } from "../subagent-transcript.js";
import type { ToolCallMeta } from "../../tools/executor.js";
import { resolveMcpUiBackend } from "../../mcp/mcp-ui-backend-resolver.js";
import type {
  ExternalUiSource,
  LoopbackUiSource,
} from "../../mcp/mcp-ui-backend-resolver.js";

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

  it("DLP-masks the MCP uiPayload title (server-authored free-text label)", () => {
    const acc = new SubAgentTranscriptAccumulator();
    acc.onToolStart("mcp_widget", {}, meta());
    // A server-authored resource TITLE that echoes PII — it enters the same
    // NEW persisted/forwarded snapshot, so it must be masked like the result.
    acc.onToolEnd(
      "mcp_widget",
      "ok",
      false,
      meta(),
      {
        serverId: "srv-1",
        resourceUri: "ui://widget/1",
        title: "report for leaked.user@example.com",
      },
      7,
    );
    const group = acc.snapshot()[0];
    if (group.kind !== "tool_group") throw new Error("expected tool_group");
    const stored = group.tools[0].uiPayload;
    expect(stored?.title).toBeDefined();
    expect(stored?.title).not.toContain("leaked.user@example.com");
    expect(stored?.title).toContain("***@example.com");
    // Structural identifiers are left verbatim (masking a URI would corrupt it).
    expect(stored?.resourceUri).toBe("ui://widget/1");
    expect(stored?.serverId).toBe("srv-1");
  });

  it("keeps the card's generation id so a sub-agent card resolves its loopback backend", () => {
    // Producer-driven: the accumulator is the ONLY hop that rebuilds the
    // uiPayload object, and the sub-agent transcript renders through the same
    // TranscriptRenderer as main chat — so a card that loses `generationId`
    // here reaches `resolveMcpUiBackend` without one and hard-fails, showing a
    // dead card. Start at the real producer, end at the real consumer.
    const acc = new SubAgentTranscriptAccumulator();
    acc.onToolStart("mcp_widget", {}, meta());
    acc.onToolEnd(
      "mcp_widget",
      "ok",
      false,
      meta(),
      {
        serverId: "my-plugin",
        generationId: "gen-abc",
        resourceUri: "ui://my-plugin/card.html",
        slot: "chat",
      },
      5,
    );
    const group = acc.snapshot()[0];
    if (group.kind !== "tool_group") throw new Error("expected tool_group");
    const stored = group.tools[0].uiPayload;

    const asserted: string[] = [];
    const loopback = {
      has: () => true,
      assertCardGeneration: (_serverId: string, generationId: string) => {
        asserted.push(generationId);
      },
      readUiResource: async () => ({}),
      resolveToolOwner: () => undefined,
      resolveOperationGrantTarget: () => undefined,
      callTool: async () => ({}),
    } as unknown as LoopbackUiSource;
    const mcpManager = {
      readUiResource: async () => ({}),
      resolveToolOwner: () => undefined,
      resolveOperationGrantTarget: () => undefined,
      callTool: async () => ({}),
    } as unknown as ExternalUiSource;

    const backend = resolveMcpUiBackend(
      stored!.serverId,
      { loopback, mcpManager },
      stored?.generationId,
    );
    expect(backend).toBeDefined();
    // The resolver binds the exact generation the host minted — not merely
    // "some truthy id".
    expect(asserted).toEqual(["gen-abc"]);
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

  it("streams reasoning deltas as a live streaming entry", () => {
    const acc = new SubAgentTranscriptAccumulator();
    acc.onReasoningDelta("Let me ");
    acc.onReasoningDelta("check the file");

    const reasoning = acc.snapshot().find((e) => e.kind === "reasoning");
    if (reasoning?.kind !== "reasoning") throw new Error("expected reasoning");
    // Accumulated, not last-delta-only — and still marked live so the panel
    // renders the "Thinking…" spinner while the child is actually thinking.
    expect(reasoning.text).toBe("Let me check the file");
    expect(reasoning.streaming).toBe(true);
  });

  it("DLP-masks the ACCUMULATION so a secret split across deltas cannot leak", () => {
    const acc = new SubAgentTranscriptAccumulator();
    // Split mid-address: neither half matches an email pattern on its own.
    acc.onReasoningDelta("mail leak");
    acc.onReasoningDelta("@example.com now");

    const joined = JSON.stringify(acc.snapshot());
    expect(joined).not.toContain("leak@example.com");
    expect(joined).toContain("***@example.com");
  });

  it("leaves the settled round identical to the round-fold-only path", () => {
    // Both accumulators stamp `createdAt` from the clock; the comparison is
    // about shape, so the clock is held still or a millisecond boundary
    // between the two rounds reads as a difference.
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const streamed = new SubAgentTranscriptAccumulator();
      streamed.onReasoningDelta("partial thou");
      streamed.onReasoningDelta("ght");
      streamed.onAssistantRound("thinking about it", "final answer");

      const folded = new SubAgentTranscriptAccumulator();
      folded.onAssistantRound("thinking about it", "final answer");

      // Persistence is unchanged by this feature: once the round closes, the
      // streamed transcript is byte-identical to the one deltas never touched.
      expect(streamed.snapshot()).toEqual(folded.snapshot());
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalizes a streamed thought even when the round reports none", () => {
    const acc = new SubAgentTranscriptAccumulator();
    acc.onReasoningDelta("mid-stream reasoning");
    // A provider that streams reasoning but reports an empty round `thought`
    // must not leave the card spinning forever.
    acc.onAssistantRound("", "answer");

    const reasoning = acc.snapshot().find((e) => e.kind === "reasoning");
    if (reasoning?.kind !== "reasoning") throw new Error("expected reasoning");
    expect(reasoning.streaming).toBe(false);
    expect(reasoning.text).toBe("mid-stream reasoning");
  });

  it("starts each round's reasoning fresh", () => {
    const acc = new SubAgentTranscriptAccumulator();
    acc.onReasoningDelta("first round thought");
    acc.onAssistantRound("first round thought", "first answer");
    acc.onReasoningDelta("second round thought");

    const live = acc.snapshot().filter((e) => e.kind === "reasoning").at(-1);
    if (live?.kind !== "reasoning") throw new Error("expected reasoning");
    expect(live.text).toBe("second round thought");
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
