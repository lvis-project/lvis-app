/**
 * Behavior-lock tests for App.handleAsk slash-command + vision branches.
 *
 * C13 pre-decomposition lock (C16 will move handleAsk into a hook). These
 * capture the CURRENT observable routing of typed composer input through
 * <App />:
 *   - "/compact"  → runs the compact IPC + banner, never chatSend.
 *   - "/load …"   → resolves a session by id-prefix and loads it, never chatSend
 *                   (empty arg / no-match surface an error and also skip send).
 *   - image on a text-only model → send-time vision confirm gate; cancel aborts
 *     the send, proceed sends with the image parts stripped.
 *
 * The trigger-import branch of handleAsk is ALREADY covered by ChatView.test.tsx
 * ("keeps overlay-import tool and final assistant output in the normal chat
 * flow" / "treats overlay imports after an existing chat as a separate turn
 * boundary") which drive handlePluginPrimaryAction → handleAsk(_, "trigger-import")
 * and assert chatSend(_, _, "plugin-emitted"). The queue-auto branch is locked
 * by ChatView-message-queue.test.tsx (drain asserts chatSend(_, _, "queue-auto")).
 *
 * Harness conventions copied from ChatView.test.tsx / AppPluginAuth.test.tsx.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { t } from "../../../i18n/runtime.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";

/**
 * Submit a "/"-prefixed command through the composer. Typing "/foo" opens the
 * caret-anchored inline slash-command menu, which OWNS Enter (accepts the
 * highlighted item instead of sending). Escape dismisses that menu for the
 * current token; the following Enter then routes to onSend → handleAsk. This
 * mirrors how a real user dismisses the autocomplete before sending a literal
 * slash command.
 */
async function submitSlashCommand(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector(
    '[data-testid="composer-textarea"]',
  ) as HTMLTextAreaElement | null;
  if (!textarea) throw new Error("composer textarea not found");
  await act(async () => {
    fireEvent.change(textarea, { target: { value: text } });
  });
  await act(async () => {
    fireEvent.keyDown(textarea, { key: "Escape", code: "Escape" });
  });
  await act(async () => {
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
  });
}

describe("App.handleAsk — /compact command routing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("routes /compact to the compact IPC + banner and does NOT chatSend", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await submitSlashCommand(container, "/compact");

    await waitFor(() => expect(api.chatCompact).toHaveBeenCalledTimes(1));
    // Default chatCompact mock reports nothing to compact → banner shows its
    // summary text ("불필요").
    await waitFor(() => expect(container.textContent).toContain("불필요"));
    expect(api.chatSend).not.toHaveBeenCalled();
  });
});

describe("App.handleAsk — /load command routing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loads a session by id-prefix and does NOT chatSend", async () => {
    const now = new Date().toISOString();
    const { container, api } = await renderApp({
      hasApiKey: true,
      sessions: [{ id: "sess-load-target-xyz", modifiedAt: now, title: "불러올 대화" }],
    });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await submitSlashCommand(container, "/load sess-load-target");

    await waitFor(() => expect(api.chatSessions).toHaveBeenCalled());
    await waitFor(() =>
      expect(api.chatSessionResume).toHaveBeenCalledWith("sess-load-target-xyz"),
    );
    expect(api.chatSessionHistory).toHaveBeenCalledWith("sess-load-target-xyz");
    expect(api.chatSend).not.toHaveBeenCalled();
  });

  it("clears live sub-agent workflow state after loading another session", async () => {
    const now = new Date().toISOString();
    const { container, api, emitAgentSpawnEvent } = await renderApp({
      hasApiKey: true,
      currentSession: "sess-current",
      sessions: [{ id: "sess-load-target-xyz", modifiedAt: now, title: "불러올 대화" }],
      history: { sessionId: "sess-current", messages: [] },
      historyBySession: {
        "sess-load-target-xyz": {
          messages: [
            { index: 0, role: "user", content: "로드된 세션 질문" },
            { index: 1, role: "assistant", content: "로드된 세션 답변" },
          ],
        },
      },
    });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await act(async () => {
      emitAgentSpawnEvent({
        spawnId: "live-old-spawn",
        type: "start",
        taskState: "TASK_STATE_SUBMITTED",
        title: "이전 세션 live 서브에이전트",
        instructions: "old live work",
        toolUseId: "old-tool",
        childSessionId: "sub-old-child",
      });
    });
    await waitFor(() => {
      expect(container.textContent).toContain("이전 세션 live 서브에이전트");
    });

    await submitSlashCommand(container, "/load sess-load-target");

    await waitFor(() =>
      expect(api.chatSessionResume).toHaveBeenCalledWith("sess-load-target-xyz"),
    );
    await waitFor(() => {
      expect(container.textContent).toContain("로드된 세션 답변");
      expect(container.textContent).not.toContain("이전 세션 live 서브에이전트");
    });
    expect(api.chatSend).not.toHaveBeenCalled();
  });

  it("surfaces a usage error for bare /load and does NOT chatSend or list sessions", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await submitSlashCommand(container, "/load");

    await waitFor(() => expect(container.textContent).toContain(t("app.loadCommandUsage")));
    // NOTE: chatSessions is called on mount for the session list, so its
    // absence cannot be asserted here; the usage-error banner + no-send are the
    // load-branch locks (the bare-/load path returns before resolving/sending).
    expect(api.chatSend).not.toHaveBeenCalled();
  });

  it("surfaces a not-found error when no session id matches the prefix", async () => {
    const now = new Date().toISOString();
    const { container, api } = await renderApp({
      hasApiKey: true,
      sessions: [{ id: "sess-other", modifiedAt: now, title: "다른 대화" }],
    });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await submitSlashCommand(container, "/load nomatch");

    await waitFor(() =>
      expect(container.textContent).toContain(t("app.sessionNotFound", { requested: "nomatch" })),
    );
    expect(api.chatSessionResume).not.toHaveBeenCalled();
    expect(api.chatSend).not.toHaveBeenCalled();
  });
});

describe("App.handleAsk — vision confirm gate on a text-only model", () => {
  const textOnlySettings = {
    llm: fakeLlmSettings({ provider: "openai", model: "o1-mini" }),
    chat: { systemPrompt: "", autoCompact: true },
    webSearch: { provider: "none" },
    routine: {},
    privacy: { piiRedactEnabled: false },
    features: { idlePreferenceRefresh: false, onboardingCompleted: true },
  };

  type AttachMock = {
    openFile: ReturnType<typeof vi.fn>;
    readImage: ReturnType<typeof vi.fn>;
    saveClipboardImage: ReturnType<typeof vi.fn>;
    openExternal: ReturnType<typeof vi.fn>;
  };

  function installImageAttachMock(): AttachMock {
    const attach: AttachMock = {
      openFile: vi.fn(async () => ({
        canceled: false,
        rejected: [],
        files: [
          {
            path: "C:\\workspace\\shot.png",
            name: "shot.png",
            ext: "png",
            bytes: 2048,
            isImage: true,
          },
        ],
      })),
      readImage: vi.fn(async () => ({
        ok: true,
        dataUrl: "data:image/png;base64,AAAA",
        mimeType: "image/png",
        width: 12,
        height: 12,
        bytes: 2048,
      })),
      saveClipboardImage: vi.fn(async () => ({ ok: false })),
      openExternal: vi.fn(async () => ({ ok: true })),
    };
    (window.lvis as unknown as { attach: AttachMock }).attach = attach;
    return attach;
  }

  afterEach(() => vi.restoreAllMocks());

  async function renderWithImageAttached() {
    const rendered = await renderApp({ hasApiKey: true, settings: textOnlySettings });
    await waitFor(() => expect(rendered.api.getSettings).toHaveBeenCalled());
    installImageAttachMock();

    await waitFor(() => {
      expect(rendered.container.querySelector('[data-testid="iab-attach-button"]')).not.toBeNull();
    });
    await act(async () => {
      fireEvent.click(rendered.container.querySelector('[data-testid="iab-attach-button"]')!);
    });
    // Single image → inline AttachmentChip renders; marker lands in composer.
    await waitFor(() => {
      expect(rendered.container.querySelector('[data-testid="attachment-chip"]')).not.toBeNull();
    });
    const textarea = rendered.container.querySelector(
      '[data-testid="composer-textarea"]',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toContain("[Image #1]");
    return { ...rendered, textarea };
  }

  it("cancel at the confirm keeps the draft and does NOT chatSend", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { api, textarea } = await renderWithImageAttached();

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(api.chatSend).not.toHaveBeenCalled();
    // Draft (marker) restored so the user can switch models and resend.
    expect(textarea.value).toContain("[Image #1]");
  });

  it("proceed at the confirm sends with the image parts stripped", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { api, textarea } = await renderWithImageAttached();

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    const sentAttachments = api.chatSend.mock.calls[0][1] as Array<{ type?: string }>;
    expect(Array.isArray(sentAttachments)).toBe(true);
    expect(sentAttachments.some((p) => p.type === "image")).toBe(false);
  });
});
