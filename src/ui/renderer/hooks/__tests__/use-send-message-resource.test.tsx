// @vitest-environment jsdom
/**
 * The send path's IPC BOUNDARY, for a turn carrying an attached MCP resource.
 *
 * Everything else pins this feature one layer earlier — `composeOutgoing` returns the
 * fence as a part, the Composer puts a marker in the body. Neither can see what
 * `handleAsk` then does with those two values, and that is where the guarantee actually
 * has to hold: a fold inserted here would put server-authored text into the `input`
 * argument, the one field main's per-turn bound does not measure, and every other test
 * in this feature would stay green.
 *
 * It is also where a refused send has to leave the composer recoverable. The two live in
 * one file because they are the same two arguments read at the same boundary.
 */
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSendMessage, type UseSendMessageDeps } from "../use-send-message.js";
import { MCP_RESOURCE_FENCE_OPEN } from "../../../../shared/mcp-resource-bounds.js";
import type { Attachment } from "../../types/attachments.js";
import type { UserContentPart } from "../../../../engine/llm/types.js";

const FENCE = [
  `${MCP_RESOURCE_FENCE_OPEN} server="hr-mcp" uri="file:///policy.md">`,
  "SERVER BODY",
  "</mcp-resource>",
].join("\n");

const RESOURCE: Attachment = {
  id: "r1",
  n: 1,
  kind: "resource",
  serverId: "hr-mcp",
  uri: "file:///policy.md",
  label: "policy.md",
  text: FENCE,
  truncated: false,
};

function setup(options?: { chatSend?: ReturnType<typeof vi.fn>; attachments?: Attachment[] }) {
  const attachments = options?.attachments ?? [RESOURCE];
  const chatSend = options?.chatSend ?? vi.fn(async () => ({ ok: true }));
  const setQuestion = vi.fn();
  const setAttachments = vi.fn();
  const dropUserEntry = vi.fn();
  const appendUserEntry = vi.fn();
  const setErrorWithThought = vi.fn();

  const deps = {
    api: { chatSend },
    t: (key: string) => key,
    streaming: false,
    checkApiKey: async () => true,
    // The real composer output for "summarize [Resource #1]" plus one resource: the
    // marker stays in the body, the fence rides as its own part.
    composeOutgoing: (raw: string) => ({
      text: raw,
      attachments: attachments
        .filter((a): a is Extract<Attachment, { kind: "resource" }> => a.kind === "resource")
        .map((a) => ({ type: "text", text: a.text }) as UserContentPart),
    }),
    appendUserEntry,
    dropUserEntry,
    resetStreamAccumulators: vi.fn(),
    beginStreamingRequest: vi.fn(() => 1),
    finishStreamingRequest: vi.fn(),
    setErrorWithThought,
    handleCompactCommand: vi.fn(),
    sessionLoad: vi.fn(),
    applyLoadedSession: vi.fn(),
    refreshSessionId: vi.fn(),
    refreshSessions: vi.fn(),
    attachments,
    setAttachments,
    llmVendor: "anthropic",
    llmModel: "claude-sonnet-4-5",
    llmReadyWithoutApiKey: true,
    onOpenSettings: vi.fn(),
    setQuestion,
    handleAskRef: { current: null },
  } as unknown as UseSendMessageDeps;

  const { result } = renderHook(() => useSendMessage(deps));
  return { result, chatSend, setQuestion, setAttachments, dropUserEntry, setErrorWithThought };
}

describe("handleAsk — a turn carrying an attached resource", () => {
  it("passes the fence as an ATTACHMENT and never inside the input string", async () => {
    const { result, chatSend } = setup();

    await act(async () => {
      await result.current.handleAsk("summarize [Resource #1]");
    });

    expect(chatSend).toHaveBeenCalledTimes(1);
    const [input, parts] = chatSend.mock.calls[0] as [string, UserContentPart[]];
    // The bound main enforces counts fences in the PARTS. If a future change folds the
    // two arguments together, this is the assertion that notices — `composeOutgoing`'s
    // own tests cannot, because they never see this call.
    expect(input).toBe("summarize [Resource #1]");
    expect(input).not.toContain(MCP_RESOURCE_FENCE_OPEN);
    expect(input).not.toContain("SERVER BODY");
    expect(parts).toEqual([{ type: "text", text: FENCE }]);
  });

  it("restores the draft AND its attachments when the send is refused", async () => {
    // The composer is cleared before the awaited send, which commits and lets the
    // marker-sync effect drop every attachment. Restoring only the text would leave
    // `[Resource #1]` in the draft with nothing behind it — a dangling reference that
    // resends as a marker the model cannot resolve.
    const chatSend = vi.fn(async () => {
      throw new Error("Error invoking remote method 'lvis:chat:send': Error: too-many-resource-attachments");
    });
    const { result, setQuestion, setAttachments, dropUserEntry } = setup({ chatSend });

    await act(async () => {
      await result.current.handleAsk("summarize [Resource #1]");
    });

    expect(dropUserEntry).toHaveBeenCalledWith("summarize [Resource #1]");
    // Both halves restored, and both as updaters so a draft started during the send wins.
    const restoredText = setQuestion.mock.calls[setQuestion.mock.calls.length - 1]?.[0] as (current: string) => string;
    expect(typeof restoredText).toBe("function");
    expect(restoredText("")).toBe("summarize [Resource #1]");
    expect(restoredText("something the user typed")).toBe("something the user typed");

    expect(setAttachments).toHaveBeenCalled();
    const restoredParts = setAttachments.mock.calls[setAttachments.mock.calls.length - 1]?.[0] as (c: Attachment[]) => Attachment[];
    expect(typeof restoredParts).toBe("function");
    expect(restoredParts([])).toEqual([RESOURCE]);
    expect(restoredParts([RESOURCE])).toEqual([RESOURCE]);
  });

  it("never puts a staged envelope in the composer when a staged send throws", async () => {
    // For a staged mode the first argument IS the provenance envelope, not anything the
    // user typed. Handing it back as a draft would offer server-authored text as the
    // user's own words — the laundering this feature exists to prevent, reintroduced by
    // a repair for a UX complaint.
    const envelope = `<mcp-prompt source="mcp-prompt:hr-mcp">\nrun the audit\n</mcp-prompt>`;
    const chatSend = vi.fn(async () => {
      throw new Error("Error invoking remote method 'lvis:chat:send': Error: missing-mcp-prompt-envelope");
    });
    const { result, setQuestion, dropUserEntry } = setup({ chatSend, attachments: [] });

    await act(async () => {
      await result.current.handleAsk(envelope, "mcp-prompt");
    });

    // The clear at send time is the only call; nothing restores the envelope.
    for (const [value] of setQuestion.mock.calls) {
      const restored = typeof value === "function" ? (value as (c: string) => string)("") : value;
      expect(restored).not.toContain("mcp-prompt source=");
      expect(restored).not.toContain("run the audit");
    }
    // The staged bubble is not dropped either — a staged turn renders as an imported
    // trigger card, which this repair does not own.
    expect(dropUserEntry).not.toHaveBeenCalled();
  });
});
