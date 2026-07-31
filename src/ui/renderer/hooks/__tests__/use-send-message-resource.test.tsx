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
import { DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES, type SubscriptionChatRuntimeSelection } from "../../../../shared/subscription-runtime.js";
import { selectSubscriptionRuntimeUiPolicy } from "../../utils/subscription-runtime-ui-policy.js";

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

const RAW_LOCAL_ATTACHMENTS: Attachment[] = [
  {
    id: "image-1",
    n: 1,
    kind: "image",
    path: "C:/work/diagram.png",
    mimeType: "image/png",
    width: 2,
    height: 2,
    bytes: 4,
    dataUrl: "data:image/png;base64,AAAA",
  },
  {
    id: "file-2",
    n: 2,
    kind: "file",
    path: "C:/work/brief.txt",
    name: "brief.txt",
    ext: "txt",
    bytes: 12,
  },
];

function setup(options?: {
  chatSend?: ReturnType<typeof vi.fn>;
  attachments?: Attachment[];
  activeSubscriptionRuntime?: SubscriptionChatRuntimeSelection | null;
  subscriptionChatReady?: boolean | null;
  subscriptionImagesReady?: boolean;
  subscriptionFilesReady?: boolean;
  subscriptionRuntimePolicy?: UseSendMessageDeps["subscriptionRuntimePolicy"];
  llmVendor?: UseSendMessageDeps["llmVendor"];
  llmModel?: UseSendMessageDeps["llmModel"];
  checkApiKey?: UseSendMessageDeps["checkApiKey"];
  settingsReady?: boolean;
}) {
  const attachments = options?.attachments ?? [RESOURCE];
  const chatSend = options?.chatSend ?? vi.fn(async () => ({ ok: true }));
  const setQuestion = vi.fn();
  const activeSubscriptionRuntime = options?.activeSubscriptionRuntime ?? null;
  const subscriptionRuntimePolicy = options?.subscriptionRuntimePolicy
    ?? selectSubscriptionRuntimeUiPolicy({
      activeSubscriptionRuntime,
      settingsLoaded: true,
      capabilities: activeSubscriptionRuntime === null || options?.subscriptionChatReady === null
        ? null
        : {
          ...DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES,
          chat: options?.subscriptionChatReady ?? false,
          images: options?.subscriptionImagesReady ?? false,
          imageAttachmentLimits: options?.subscriptionImagesReady
            ? {
              maxCount: 5,
              maxBytesPerImage: 25 * 1024 * 1024,
              maxTotalBytes: 25 * 1024 * 1024,
            }
            : null,
          files: options?.subscriptionFilesReady ?? false,
        },
    });
  const setAttachments = vi.fn();
  const dropUserEntry = vi.fn();
  const appendUserEntry = vi.fn();
  const setErrorWithThought = vi.fn();

  const deps = {
    api: { chatSend },
    t: (key: string) => key,
    streaming: false,
    checkApiKey: options?.checkApiKey ?? (async () => true),
    // The real composer output for "summarize [Resource #1]" plus one resource: the
    // marker stays in the body, the fence rides as its own part.
    composeOutgoing: (raw: string) => ({
      text: raw,
      attachments: attachments.flatMap((attachment): UserContentPart[] => {
        if (attachment.kind === "resource") {
          return [{ type: "text", text: attachment.text }];
        }
        if (attachment.kind === "image") {
          return [{
            type: "image",
            image: attachment.dataUrl,
            mimeType: attachment.mimeType,
            width: attachment.width,
            height: attachment.height,
            bytes: attachment.bytes,
          }];
        }
        return [];
      }),
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
    llmVendor: options?.llmVendor ?? "anthropic",
    llmModel: options?.llmModel ?? "claude-sonnet-4-5",
    llmReadyWithoutApiKey: true,
    subscriptionRuntimePolicy,
    settingsReady: options?.settingsReady ?? true,
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

  it("blocks unsupported subscription image and file egress without changing the draft", async () => {
    const confirm = vi.spyOn(window, "confirm");
    try {
      const {
        result,
        chatSend,
        setQuestion,
        setAttachments,
        setErrorWithThought,
      } = setup({
        attachments: RAW_LOCAL_ATTACHMENTS,
        activeSubscriptionRuntime: { kind: "subscription", provider: "codex" },
        subscriptionChatReady: true,
      });

      await act(async () => {
        await result.current.handleAsk("review [Image #1] [File #2]");
      });

      expect(confirm).not.toHaveBeenCalled();
      expect(chatSend).not.toHaveBeenCalled();
      // The block happens before composer clearing and cleanup, preserving the
      // exact draft + attachments until this runtime supports raw upload.
      expect(setQuestion).not.toHaveBeenCalled();
      expect(setAttachments).not.toHaveBeenCalled();
      expect(setErrorWithThought).toHaveBeenCalledWith("app.subscriptionAttachmentUnsupported");
    } finally {
      confirm.mockRestore();
    }
  });

  it("blocks a verified subscription image that exceeds its negotiated byte budget", async () => {
    const subscriptionRuntimePolicy = selectSubscriptionRuntimeUiPolicy({
      activeSubscriptionRuntime: { kind: "subscription", provider: "codex" },
      settingsLoaded: true,
      capabilities: {
        ...DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES,
        chat: true,
        images: true,
        imageAttachmentLimits: {
          maxCount: 5,
          maxBytesPerImage: 3,
          maxTotalBytes: 3,
        },
      },
    });
    const { result, chatSend, setQuestion, setAttachments, setErrorWithThought } = setup({
      attachments: RAW_LOCAL_ATTACHMENTS.filter((attachment) => attachment.kind === "image"),
      subscriptionRuntimePolicy,
    });

    await act(async () => {
      await result.current.handleAsk("review [Image #1]");
    });

    expect(chatSend).not.toHaveBeenCalled();
    expect(setQuestion).not.toHaveBeenCalled();
    expect(setAttachments).not.toHaveBeenCalled();
    expect(setErrorWithThought).toHaveBeenCalledWith("app.subscriptionAttachmentUnsupported");
  });

  it("sends a verified subscription image without consulting the inactive API-key model", async () => {
    const confirm = vi.spyOn(window, "confirm");
    try {
      const { result, chatSend, setErrorWithThought } = setup({
        attachments: RAW_LOCAL_ATTACHMENTS.filter((attachment) => attachment.kind === "image"),
        activeSubscriptionRuntime: { kind: "subscription", provider: "codex" },
        subscriptionChatReady: true,
        subscriptionImagesReady: true,
        subscriptionFilesReady: false,
        llmVendor: "openai",
        llmModel: "gpt-3.5-turbo",
      });

      await act(async () => {
        await result.current.handleAsk("review [Image #1]");
      });

      expect(confirm).not.toHaveBeenCalled();
      expect(setErrorWithThought).not.toHaveBeenCalled();
      expect(chatSend).toHaveBeenCalledTimes(1);
      const [, parts] = chatSend.mock.calls[0] as [string, UserContentPart[]];
      expect(parts).toEqual([expect.objectContaining({ type: "image", image: "data:image/png;base64,AAAA" })]);
    } finally {
      confirm.mockRestore();
    }
  });

  it("does not send while the initial runtime settings snapshot is unresolved", async () => {
    const checkApiKey = vi.fn(async () => true);
    const { result, chatSend } = setup({
      attachments: [],
      settingsReady: false,
      checkApiKey,
    });

    await act(async () => {
      await result.current.handleAsk("wait for authoritative runtime selection");
    });

    expect(checkApiKey).not.toHaveBeenCalled();
    expect(chatSend).not.toHaveBeenCalled();
  });

  it("does not consult an inactive stored API key when subscription chat is unavailable", async () => {
    const checkApiKey = vi.fn(async () => true);
    const { result, chatSend } = setup({
      attachments: [],
      activeSubscriptionRuntime: { kind: "subscription", provider: "codex" },
      subscriptionChatReady: false,
      checkApiKey,
    });

    await act(async () => {
      await result.current.handleAsk("do not fall back to the legacy key");
    });

    expect(checkApiKey).not.toHaveBeenCalled();
    expect(chatSend).not.toHaveBeenCalled();
  });

  it("does not consult an inactive stored API key while subscription chat verification is pending", async () => {
    const checkApiKey = vi.fn(async () => true);
    const { result, chatSend } = setup({
      attachments: [],
      activeSubscriptionRuntime: { kind: "subscription", provider: "codex" },
      subscriptionChatReady: null,
      checkApiKey,
    });

    await act(async () => {
      await result.current.handleAsk("do not fall back while login status is pending");
    });

    expect(checkApiKey).not.toHaveBeenCalled();
    expect(chatSend).not.toHaveBeenCalled();
  });
});
