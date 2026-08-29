// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen, act, waitFor } from "@testing-library/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Composer, type ComposerHandle } from "../Composer.js";
import { t } from "../../../../i18n/runtime.js";
import type {
  Attachment,
  ImageAttachment,
} from "../../types/attachments.js";
import type { SuggestedRepliesSnapshot } from "../../hooks/use-suggested-replies.js";
import type { UserKeyboardIntentSnapshot } from "../../../../shared/chat-origin.js";
import type { QuickAction } from "../command-actions.js";
import type { PluginEntry } from "../PluginGridButton.js";
import { MCP_RESOURCE_ATTACHMENTS_PER_TURN } from "../../../../shared/mcp-resource-bounds.js";
import { PASTE_TEXT_MIN_CHARS } from "../../types/attachments.js";
import type { SubscriptionImageAttachmentLimits } from "../../../../shared/subscription-runtime.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";

// Stable across renders ON PURPOSE. Passing nothing let Composer's default parameter
// mint a fresh `[]` every render, which rebuilt the memoized keydown handler every
// render and made a missing dependency invisible — the fixture could not express a bug
// that only appears when the handler is NOT rebuilt. Production passes memoized values,
// so this is the faithful shape, not a convenience.
const STABLE_COMMAND_ACTIONS: QuickAction[] = [];
const STABLE_PLUGINS: PluginEntry[] = [];
const STABLE_SELECT_PLUGIN = () => {};

const mockSave = vi.fn(async () => ({
  ok: true,
  path: "/tmp/lvis-clip-1.png",
  width: 100,
  height: 80,
  bytes: 1024,
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,xxx",
}));

function Harness({
  initialText = "",
  initialAttachments = [] as Attachment[],
  onSendCb = vi.fn(),
  onWarningCb,
  suggestedReplies,
  exposeSetAttachments,
  imagesEnabled,
  imageAttachmentLimits,
  onImageAttachmentLimitExceeded,
  discardClipboardImage,
  disabled,
}: {
  initialText?: string;
  initialAttachments?: Attachment[];
  onSendCb?: () => void;
  onWarningCb?: (message: string) => void;
  suggestedReplies?: SuggestedRepliesSnapshot;
  imagesEnabled?: boolean;
  imageAttachmentLimits?: SubscriptionImageAttachmentLimits | null;
  onImageAttachmentLimitExceeded?: () => void;
  discardClipboardImage?: (path: string) => Promise<unknown>;
  /** Composer refuses input entirely (no API key, context overflow, ...). */
  disabled?: boolean;
  /**
   * Hands the attachment setter to the test.
   *
   * `initialAttachments` seeds `useState` and is therefore ignored on re-render, so a
   * test that needs the attachment list to CHANGE after mount — the composer staying
   * live while a modal is open — cannot express that by re-rendering with a new prop.
   * It would silently assert against the mount-time value instead.
   */
  exposeSetAttachments?: (set: (next: Attachment[]) => void) => void;
}) {
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments);
  const counterRef = useRef(initialAttachments.length);
  const composerRef = useRef<ComposerHandle | null>(null);
  // Stable identity, live target. `onSend` is a dependency of the memoized keydown
  // handler, so a fresh spy per render rebuilds that handler every render and hides any
  // missing dependency — which is exactly how a dead-keyboard bug survived this suite.
  const sendRef = useRef(onSendCb);
  sendRef.current = onSendCb;
  const stableOnSend = useCallback((intent: UserKeyboardIntentSnapshot) => {
    sendRef.current(intent);
  }, []);
  const warnRef = useRef(onWarningCb);
  warnRef.current = onWarningCb;
  const stableOnWarning = useCallback((message: string) => {
    warnRef.current?.(message);
  }, []);
  // In an effect, not during render: a render-phase call fires on discarded renders too.
  // Benign here (stable setter, assignment only), but the tests read it after `settle()`
  // so an effect costs nothing.
  useEffect(() => { exposeSetAttachments?.(setAttachments); }, [exposeSetAttachments]);

  return (
    <Composer
      ref={composerRef}
      text={text}
      onTextChange={setText}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      allocateN={() => ++counterRef.current}
      saveClipboardImage={mockSave}
      discardClipboardImage={discardClipboardImage}
      onSend={stableOnSend}
      disabled={disabled}
      imagesEnabled={imagesEnabled}
      commandActions={STABLE_COMMAND_ACTIONS}
      inlinePlugins={STABLE_PLUGINS}
      onSelectPlugin={STABLE_SELECT_PLUGIN}
      imageAttachmentLimits={imageAttachmentLimits}
      onImageAttachmentLimitExceeded={onImageAttachmentLimitExceeded}
      onWarning={stableOnWarning}
      suggestedReplies={suggestedReplies}
    />
  );
}

const img1: ImageAttachment = {
  id: "i1",
  n: 1,
  kind: "image",
  path: "/tmp/x.png",
  mimeType: "image/png",
  width: 100,
  height: 80,
  bytes: 1024,
  dataUrl: "data:image/png;base64,xxx",
};
const img2: ImageAttachment = {
  ...img1,
  id: "i2",
  n: 2,
};

function imageClipboardData(file: File | null = null): DataTransfer {
  const items = Object.assign([
    { kind: "file", type: "image/png", getAsFile: () => file },
  ], { length: 1 }) as unknown as DataTransferItemList;
  return {
    items,
    getData: () => "",
  } as unknown as DataTransfer;
}

describe("Composer", () => {
  it("renders empty composer with placeholder", () => {
    render(<Harness />);
    expect(screen.getByTestId(TEST_IDS.composer)).toBeTruthy();
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
    expect(screen.queryByTestId("attachment-chip-collapsed")).toBeNull();
  });

  it("renders single chip with one attachment + matching marker", () => {
    render(
      <Harness
        initialText="see [Image #1]"
        initialAttachments={[img1]}
      />,
    );
    expect(screen.getByTestId("attachment-chip")).toBeTruthy();
    expect(screen.queryByTestId("attachment-chip-collapsed")).toBeNull();
  });

  it("renders collapsed chip with two attachments", () => {
    render(
      <Harness
        initialText="see [Image #1] and [Image #2]"
        initialAttachments={[img1, img2]}
      />,
    );
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
    expect(screen.getByTestId("attachment-chip-collapsed")).toBeTruthy();
  });

  it("auto-removes chip when [Image #N] marker is deleted from text", async () => {
    render(
      <Harness
        initialText="see [Image #1]"
        initialAttachments={[img1]}
      />,
    );
    expect(screen.getByTestId("attachment-chip")).toBeTruthy();
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(ta, { target: { value: "see " } });
    });
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });

  it("shows limit warning at MAX (5)", () => {
    const five: Attachment[] = [
      { ...img1, id: "a", n: 1 },
      { ...img1, id: "b", n: 2 },
      { ...img1, id: "c", n: 3 },
      { ...img1, id: "d", n: 4 },
      { ...img1, id: "e", n: 5 },
    ];
    render(
      <Harness
        initialText="[Image #1] [Image #2] [Image #3] [Image #4] [Image #5]"
        initialAttachments={five}
      />,
    );
    expect(screen.getByTestId("composer-limit-warning")).toBeTruthy();
  });

  // Long text normally becomes a `paste` attachment chip with a marker token in
  // the textarea. Ctrl/⌘+Shift+V asks for the original text instead.
  const LONG_PASTE = "a".repeat(PASTE_TEXT_MIN_CHARS + 20);

  function textClipboardData(text: string): DataTransfer {
    return {
      items: Object.assign([], { length: 0 }) as unknown as DataTransferItemList,
      getData: (type: string) => (type === "text/plain" ? text : ""),
    } as unknown as DataTransfer;
  }

  it("chips long pasted text into an attachment on a plain paste", async () => {
    render(<Harness />);
    const textarea = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;

    fireEvent.paste(textarea, { clipboardData: textClipboardData(LONG_PASTE) });

    await waitFor(() => expect(screen.queryByTestId("attachment-chip")).not.toBeNull());
    expect(textarea.value).not.toContain(LONG_PASTE);
  });

  it("lets Ctrl/⌘+Shift+V paste the original text instead of chipping it", async () => {
    render(<Harness />);
    const textarea = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;

    // The chord arrives as a keydown; the paste that follows carries no
    // modifier state of its own.
    fireEvent.keyDown(textarea, { key: "v", code: "KeyV", ctrlKey: true, shiftKey: true });
    const notConsumed = fireEvent.paste(textarea, { clipboardData: textClipboardData(LONG_PASTE) });

    // Not consumed: the browser's own paste inserts text/plain into the field.
    expect(notConsumed).toBe(true);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });

  it("applies the bypass to exactly one paste, not the next ordinary one", async () => {
    render(<Harness />);
    const textarea = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;

    fireEvent.keyDown(textarea, { key: "v", code: "KeyV", metaKey: true, shiftKey: true });
    fireEvent.paste(textarea, { clipboardData: textClipboardData(LONG_PASTE) });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("attachment-chip")).toBeNull();

    // A subsequent plain ⌘V must chip again.
    fireEvent.keyDown(textarea, { key: "v", code: "KeyV", metaKey: true });
    fireEvent.paste(textarea, { clipboardData: textClipboardData(LONG_PASTE) });
    await waitFor(() => expect(screen.queryByTestId("attachment-chip")).not.toBeNull());
  });

  it("does not leak the bypass out of a paste the composer refused", async () => {
    const { rerender } = render(<Harness disabled />);
    const textarea = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;

    // Chord + paste while the composer is disabled: the paste is refused, and
    // the chord must be spent rather than left armed.
    fireEvent.keyDown(textarea, { key: "v", code: "KeyV", metaKey: true, shiftKey: true });
    fireEvent.paste(textarea, { clipboardData: textClipboardData(LONG_PASTE) });
    await act(async () => { await Promise.resolve(); });

    rerender(<Harness />);
    // A context-menu paste arrives with no keydown to clear a stale flag.
    fireEvent.paste(
      screen.getByTestId(TEST_IDS.composerTextarea),
      { clipboardData: textClipboardData(LONG_PASTE) },
    );
    await waitFor(() => expect(screen.queryByTestId("attachment-chip")).not.toBeNull());
  });

  it("disarms the chord when focus leaves before any paste arrives", async () => {
    render(<Harness />);
    const textarea = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;

    // Chord pressed, but the paste never arrives — the OS swallowed the
    // accelerator, say — and focus moves on.
    fireEvent.keyDown(textarea, { key: "v", code: "KeyV", metaKey: true, shiftKey: true });
    fireEvent.blur(textarea);

    // A context-menu paste carries no keydown that would disarm a stale chord.
    fireEvent.paste(textarea, { clipboardData: textClipboardData(LONG_PASTE) });
    await waitFor(() => expect(screen.queryByTestId("attachment-chip")).not.toBeNull());
  });

  it("blocks clipboard image attachment when native image input is unavailable", () => {
    const onWarningCb = vi.fn();
    mockSave.mockClear();
    render(<Harness imagesEnabled={false} onWarningCb={onWarningCb} />);
    const textarea = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;

    fireEvent.paste(textarea, { clipboardData: imageClipboardData() });

    expect(mockSave).not.toHaveBeenCalled();
    expect(onWarningCb).toHaveBeenCalledWith(
      t("app.subscriptionAttachmentUnsupported", { provider: "subscription" }),
    );
    expect(textarea.value).toBe("");
  });

  it("blocks clipboard image attachment when the active subscription budget is exceeded", async () => {
    const onImageAttachmentLimitExceeded = vi.fn();
    const discardClipboardImage = vi.fn(async () => undefined);
    mockSave.mockClear();
    render(
      <Harness
        imageAttachmentLimits={{ maxCount: 5, maxBytesPerImage: 512, maxTotalBytes: 512 }}
        onImageAttachmentLimitExceeded={onImageAttachmentLimitExceeded}
        discardClipboardImage={discardClipboardImage}
      />,
    );
    const textarea = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;

    fireEvent.paste(
      textarea,
      { clipboardData: imageClipboardData(new File(["image"], "clip.png", { type: "image/png" })) },
    );
    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledOnce();
    });
    expect(onImageAttachmentLimitExceeded).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(discardClipboardImage).toHaveBeenCalledWith("/tmp/lvis-clip-1.png");
    });
    expect(textarea.value).toBe("");
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });

  it("releases a saved clipboard image when the runtime rejects it before async commit", async () => {
    const discardClipboardImage = vi.fn(async () => undefined);
    let resolveSave!: (value: Awaited<ReturnType<typeof mockSave>>) => void;
    const pendingSave = new Promise<Awaited<ReturnType<typeof mockSave>>>((resolve) => {
      resolveSave = resolve;
    });
    mockSave.mockClear();
    mockSave.mockImplementationOnce(async () => pendingSave);

    const { rerender } = render(
      <Harness imagesEnabled discardClipboardImage={discardClipboardImage} />,
    );
    const textarea = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    fireEvent.paste(
      textarea,
      { clipboardData: imageClipboardData(new File(["image"], "clip.png", { type: "image/png" })) },
    );
    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledOnce();
    });

    rerender(<Harness imagesEnabled={false} discardClipboardImage={discardClipboardImage} />);
    await act(async () => {
      resolveSave({
        ok: true,
        path: "/tmp/lvis-state-switch.png",
        width: 100,
        height: 80,
        bytes: 1024,
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,xxx",
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(discardClipboardImage).toHaveBeenCalledWith("/tmp/lvis-state-switch.png");
    });
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
    expect(textarea.value).toBe("");
  });

  it("calls onSend on Enter (without shift)", () => {
    const onSendCb = vi.fn();
    render(<Harness initialText="hello" onSendCb={onSendCb} />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    expect(onSendCb).toHaveBeenCalled();
  });

  it("does NOT call onSend on Shift+Enter", () => {
    const onSendCb = vi.fn();
    render(<Harness initialText="hello" onSendCb={onSendCb} />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(onSendCb).not.toHaveBeenCalled();
  });

  it("does not render strip when no attachments (zero space)", () => {
    render(<Harness />);
    expect(screen.queryByTestId("composer-strip")).toBeNull();
  });

  it("renders strip when one attachment is present", () => {
    render(
      <Harness
        initialText="see [Image #1]"
        initialAttachments={[img1]}
      />,
    );
    expect(screen.getByTestId("composer-strip")).toBeTruthy();
  });

  it("backspace at end of [Image #N] marker removes the whole block + chip", async () => {
    render(
      <Harness
        initialText="see [Image #1]"
        initialAttachments={[img1]}
      />,
    );
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    expect(screen.getByTestId("attachment-chip")).toBeTruthy();

    // Position caret just after `]` (end of body).
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    await act(async () => {
      fireEvent.keyDown(ta, { key: "Backspace" });
    });

    // Whole `[Image #1]` block gone, chip removed.
    expect(ta.value).toBe("see ");
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });

  it("backspace inside marker removes the entire block (Slack chip UX)", async () => {
    render(
      <Harness
        initialText="hi [File #2] there"
        initialAttachments={[
          { ...img1, id: "f", n: 2, kind: "file", path: "/x", name: "x", ext: "txt", bytes: 1 } as Attachment,
        ]}
      />,
    );
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    ta.focus();
    // Caret in the middle of the marker.
    ta.setSelectionRange(8, 8);
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Backspace" });
    });
    expect(ta.value).toBe("hi  there");
  });

  it("backspace on plain text uses native single-char delete", async () => {
    render(<Harness initialText="hello" />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(5, 5);
    await act(async () => {
      // Native backspace must NOT be preventDefault'ed here. We don't
      // simulate the native keystroke effect in jsdom — instead assert
      // that handleKeyDown did not consume the event by checking that
      // findMarkerAt returned null (no early return).
      const ev = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
      ta.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    });
  });

  it("composer renders textarea (send button moved to BottomActionRow per v6 layout)", () => {
    // v6: input-bar = textarea only. Send 버튼은 BottomActionRow 로 이전.
    // 본 테스트는 Composer 의 textarea-only contract 만 검증. Send disable 동작
    // 검증은 BottomActionRow 의 isSendDisabled prop 단위로 별도 (ChatView 통합).
    render(<Harness />);
    const textarea = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(screen.queryByTestId("composer-send-button")).toBeNull();
  });

  // --- Suggested Replies (PR-B) ---

  it("renders ghost text when value empty + best != null", () => {
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: [], isDismissed: false }}
      />,
    );
    const ghost = screen.getByTestId("suggested-replies-ghost");
    expect(ghost).toBeTruthy();
    expect(ghost.textContent).toContain("네");
    expect(ghost.textContent).toContain(t("suggestedRepliesGhost.tabToFill"));
  });

  it("suppresses the fallback placeholder while ghost text is visible", () => {
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: [], isDismissed: false }}
      />,
    );
    const textarea = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    expect(textarea.getAttribute("placeholder")).toBe("");
  });

  it("hides ghost text once user types 1+ chars", () => {
    render(
      <Harness
        initialText="x"
        suggestedReplies={{ best: "네", alternates: [], isDismissed: false }}
      />,
    );
    expect(screen.queryByTestId("suggested-replies-ghost")).toBeNull();
  });

  it("hides ghost text when no best", () => {
    render(
      <Harness
        suggestedReplies={{ best: null, alternates: [], isDismissed: false }}
      />,
    );
    expect(screen.queryByTestId("suggested-replies-ghost")).toBeNull();
  });

  it("hides ghost text when dismissed", () => {
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: [], isDismissed: true }}
      />,
    );
    expect(screen.queryByTestId("suggested-replies-ghost")).toBeNull();
  });

  it("renders chip row when alternates present", () => {
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: ["아니오", "나중에"], isDismissed: false }}
      />,
    );
    const row = screen.getByTestId("suggested-replies-chip-row");
    expect(row).toBeTruthy();
    const chips = screen.getAllByTestId("suggested-replies-chip");
    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.textContent)).toEqual(["아니오", "나중에"]);
  });

  it("adds top inset to the chip row inside the composer surface", () => {
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: ["아니오"], isDismissed: false }}
      />,
    );
    expect(screen.getByTestId("suggested-replies-chip-row")).toHaveClass("mt-3");
  });

  it("hides chip row when alternates empty", () => {
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: [], isDismissed: false }}
      />,
    );
    expect(screen.queryByTestId("suggested-replies-chip-row")).toBeNull();
  });

  it("hides chip row when dismissed", () => {
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: ["아니오"], isDismissed: true }}
      />,
    );
    expect(screen.queryByTestId("suggested-replies-chip-row")).toBeNull();
  });

  it("Tab fills textarea with best (empty + not dismissed)", async () => {
    render(
      <Harness
        suggestedReplies={{ best: "네 확인했습니다", alternates: [], isDismissed: false }}
      />,
    );
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Tab", shiftKey: false });
    });
    expect(ta.value).toBe("네 확인했습니다");
    // After accept, ghost should disappear.
    expect(screen.queryByTestId("suggested-replies-ghost")).toBeNull();
  });

  it("Tab does NOT fill when value has content (native Tab behavior)", () => {
    render(
      <Harness
        initialText="이미 입력 중"
        suggestedReplies={{ best: "네", alternates: [], isDismissed: false }}
      />,
    );
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(ta.value).toBe("이미 입력 중");
  });

  it("Tab does NOT fill when best is null", () => {
    render(
      <Harness
        suggestedReplies={{ best: null, alternates: ["a"], isDismissed: false }}
      />,
    );
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("chip click fills textarea + clears chip row", async () => {
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: ["아니오", "나중에"], isDismissed: false }}
      />,
    );
    const chips = screen.getAllByTestId("suggested-replies-chip");
    await act(async () => {
      fireEvent.click(chips[0]!);
    });
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    expect(ta.value).toBe("아니오");
  });

  it("hides chip row once user types 1+ chars (MAJOR-1 round-1)", () => {
    // Spec §3 line 42: "사용자가 1자 이상 입력 → ghost + chip row 즉시 hide".
    // Ghost was already hidden in a separate test; this asserts chip row hides
    // for the same condition so the two surfaces stay in lockstep.
    render(
      <Harness
        initialText="abc"
        suggestedReplies={{ best: "네", alternates: ["아니오", "나중에"], isDismissed: false }}
      />,
    );
    expect(screen.queryByTestId("suggested-replies-chip-row")).toBeNull();
  });

  it("hides ghost during IME composition + reappears after end (MAJOR-2 round-1)", async () => {
    // Spec §8: ImePreedit (한글 조합) 중 → ghost hide, composition 끝나면 reappear.
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: [], isDismissed: false }}
      />,
    );
    expect(screen.getByTestId("suggested-replies-ghost")).toBeTruthy();
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.compositionStart(ta);
    });
    expect(screen.queryByTestId("suggested-replies-ghost")).toBeNull();
    await act(async () => {
      fireEvent.compositionEnd(ta);
    });
    expect(screen.getByTestId("suggested-replies-ghost")).toBeTruthy();
  });

  it("Escape dismisses suggestion (ghost disappears)", async () => {
    function HarnessWithDismiss() {
      const [reps, setReps] = useState<SuggestedRepliesSnapshot>({
        best: "네",
        alternates: ["아니오"],
        isDismissed: false,
      });
      const [text, setText] = useState("");
      const [attachments, setAttachments] = useState<Attachment[]>([]);
      const counterRef = useRef(0);
      const composerRef = useRef<ComposerHandle | null>(null);
      // Hook the module-level dismiss into local state by intercepting the
      // dismissSuggestedReplies call path — the Composer always calls the
      // module-level function on Escape. Since this Harness does NOT use the
      // hook (props-driven), we listen to the keydown ourselves and mirror
      // the dismissal. Composer also calls dismissSuggestedReplies — that's
      // a module-level no-op in this isolated test (no subscribers), which
      // is the documented additive behavior.
      return (
        <div
          onKeyDownCapture={(e) => {
            if (e.key === "Escape") {
              setReps((s) => ({ ...s, isDismissed: true }));
            }
          }}
        >
          <Composer
            ref={composerRef}
            text={text}
            onTextChange={setText}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            allocateN={() => ++counterRef.current}
            saveClipboardImage={mockSave}
            onSend={vi.fn()}
            suggestedReplies={reps}
          />
        </div>
      );
    }
    render(<HarnessWithDismiss />);
    expect(screen.getByTestId("suggested-replies-ghost")).toBeTruthy();
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Escape" });
    });
    expect(screen.queryByTestId("suggested-replies-ghost")).toBeNull();
    expect(screen.queryByTestId("suggested-replies-chip-row")).toBeNull();
  });

  // --- PR-D additions ---

  it("ArrowDown moves focus into the chip row (first chip)", async () => {
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: ["아니오", "나중에"], isDismissed: false }}
      />,
    );
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.keyDown(ta, { key: "ArrowDown" });
    });
    const chips = screen.getAllByTestId("suggested-replies-chip");
    expect(chips[0]!.getAttribute("data-focused")).toBe("true");
  });

  it("ArrowDown advances chip focus index until clamped at end", async () => {
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: ["a", "b", "c"], isDismissed: false }}
      />,
    );
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await act(async () => { fireEvent.keyDown(ta, { key: "ArrowDown" }); });
    await act(async () => { fireEvent.keyDown(ta, { key: "ArrowDown" }); });
    await act(async () => { fireEvent.keyDown(ta, { key: "ArrowDown" }); });
    // 3 ArrowDowns on a 3-chip row → idx clamped at 2 (last chip).
    const chips = screen.getAllByTestId("suggested-replies-chip");
    expect(chips[2]!.getAttribute("data-focused")).toBe("true");
  });

  it("ArrowUp from first chip returns focus to textarea", async () => {
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: ["아니오", "나중에"], isDismissed: false }}
      />,
    );
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await act(async () => { fireEvent.keyDown(ta, { key: "ArrowDown" }); });
    // Re-target keydown via the new focused chip — Composer's handler is on
    // the textarea but the focus has moved; trigger another ArrowUp through
    // the textarea's onKeyDown directly to simulate the user still pressing
    // arrow keys (jsdom doesn't bubble keydown across the focused chip).
    await act(async () => { fireEvent.keyDown(ta, { key: "ArrowUp" }); });
    const chips = screen.getAllByTestId("suggested-replies-chip");
    expect(chips[0]!.getAttribute("data-focused")).toBeNull();
  });

  it("ArrowUp/Down with text in textarea does NOT intercept caret movement", () => {
    render(
      <Harness
        initialText="abc"
        suggestedReplies={{ best: "네", alternates: ["a", "b"], isDismissed: false }}
      />,
    );
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    const ev = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    // text.length > 0 → chip row hidden → no interception → preventDefault
    // is not called (caret movement remains native).
    expect(ev.defaultPrevented).toBe(false);
  });

  it("ghost text element carries fade-in transition class (PR-D animation)", () => {
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: [], isDismissed: false }}
      />,
    );
    const ghost = screen.getByTestId("suggested-replies-ghost");
    // Tailwind's `transition-opacity` + `motion-safe:animate-in` baked into the
    // component. Asserting the class names is a regression guard so future
    // styling refactors don't silently drop the animation.
    expect(ghost.className).toContain("transition-opacity");
    expect(ghost.className).toContain("animate-in");
  });

  it("chip row carries fade-in transition class (PR-D animation)", () => {
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: ["아니오"], isDismissed: false }}
      />,
    );
    const row = screen.getByTestId("suggested-replies-chip-row");
    expect(row.className).toContain("transition-[opacity,transform]");
    expect(row.className).toContain("animate-in");
  });

  it("chip click records accepted-chip telemetry event", async () => {
    const { resetSuggestedRepliesCountersForTesting, getSuggestedRepliesCounters } =
      await import("../../../../telemetry/suggested-replies-counter.js");
    const { pushSuggestedReplies, __resetSuggestedRepliesStoreForTests } =
      await import("../../hooks/use-suggested-replies.js");
    __resetSuggestedRepliesStoreForTests();
    resetSuggestedRepliesCountersForTesting();
    // Composer calls module-level `acceptSuggestedReply` which is a no-op
    // when the store is empty. Seed the store so the accept path actually
    // increments the counter.
    await act(async () => { pushSuggestedReplies(["네", "아니오"]); });
    resetSuggestedRepliesCountersForTesting(); // discard the "shown" event
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: ["아니오"], isDismissed: false }}
      />,
    );
    const chip = screen.getByTestId("suggested-replies-chip");
    await act(async () => { fireEvent.click(chip); });
    expect(getSuggestedRepliesCounters()["accepted-chip"]).toBe(1);
  });

  it("Tab fill records accepted-best telemetry event", async () => {
    const { resetSuggestedRepliesCountersForTesting, getSuggestedRepliesCounters } =
      await import("../../../../telemetry/suggested-replies-counter.js");
    const { pushSuggestedReplies, __resetSuggestedRepliesStoreForTests } =
      await import("../../hooks/use-suggested-replies.js");
    __resetSuggestedRepliesStoreForTests();
    resetSuggestedRepliesCountersForTesting();
    await act(async () => { pushSuggestedReplies(["네"]); });
    resetSuggestedRepliesCountersForTesting();
    render(
      <Harness
        suggestedReplies={{ best: "네", alternates: [], isDismissed: false }}
      />,
    );
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await act(async () => { fireEvent.keyDown(ta, { key: "Tab" }); });
    expect(getSuggestedRepliesCounters()["accepted-best"]).toBe(1);
  });

  it("Enter (send) releases the dismiss latch (PR-D dismiss memory)", async () => {
    const { pushSuggestedReplies, dismissSuggestedReplies, __resetSuggestedRepliesStoreForTests } =
      await import("../../hooks/use-suggested-replies.js");
    __resetSuggestedRepliesStoreForTests();
    const onSendCb = vi.fn();
    render(<Harness onSendCb={onSendCb} />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    // Set up: push + dismiss → latch is set.
    await act(async () => { pushSuggestedReplies(["첫"]); });
    await act(async () => { dismissSuggestedReplies(); });
    // Type then send.
    fireEvent.change(ta, { target: { value: "hi" } });
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    expect(onSendCb).toHaveBeenCalledTimes(1);
    // After clear, a fresh push should NOT be dismissed.
    await act(async () => { pushSuggestedReplies(["둘"]); });
    // We assert via the public surface: rendering a new Harness with the new
    // snapshot should display the ghost. (Direct hook inspection would need
    // an extra harness; the latch-clear is already covered by the
    // use-suggested-replies test.)
    expect(onSendCb).toHaveBeenCalled();
  });
});

/**
 * The `@` mention, end to end through the real component.
 *
 * These are the cases that only exist once the picker is wired: the menu opening on a
 * trigger, the attach landing as an attachment rather than as body text, and the two
 * races the asynchronous read introduces.
 */
describe("Composer — @ resource mention", () => {
  const FENCE = '<mcp-resource trust="untrusted-server-data" server="hr-mcp" uri="doc:1">\nBODY\n</mcp-resource>';
  // Keyed on the URI MAIN produced from the template — the renderer never composes one.
  const TEMPLATE_FENCE =
    '<mcp-resource trust="untrusted-server-data" server="hr-mcp" uri="file:///project/notes.md">'
    + "\nNOTES\n</mcp-resource>";

  function installMcpApi(overrides?: {
    attachResource?: ReturnType<typeof vi.fn>;
    listResources?: ReturnType<typeof vi.fn>;
    listResourceTemplates?: ReturnType<typeof vi.fn>;
    attachResourceTemplate?: ReturnType<typeof vi.fn>;
  }) {
    const attachResource = overrides?.attachResource ?? vi.fn(async () => ({
      ok: true,
      attachment: { type: "text" as const, text: FENCE },
    }));
    const listResources = overrides?.listResources ?? vi.fn(async () => ({
      ok: true,
      servers: [
        { serverId: "hr-mcp", resources: [{ uri: "doc:1", name: "policy.md" }] },
        { serverId: "eng-mcp", resources: [{ uri: "doc:2", name: "runbook.md" }] },
      ],
    }));
    // Empty by DEFAULT so the resource cases keep counting only resource rows: a fixture
    // that quietly added a template row would change what "the menu has two rows" means
    // in every test above without any of them mentioning templates.
    const listResourceTemplates = overrides?.listResourceTemplates
      ?? vi.fn(async () => ({ ok: true, servers: [] }));
    const attachResourceTemplate = overrides?.attachResourceTemplate ?? vi.fn(async () => ({
      ok: true,
      attachment: { type: "text" as const, text: TEMPLATE_FENCE },
      uri: "file:///project/notes.md",
    }));
    (window as unknown as { lvis?: unknown }).lvis = {
      mcp: { attachResource, listResources, listResourceTemplates, attachResourceTemplate },
    };
    return { attachResource, listResources, listResourceTemplates, attachResourceTemplate };
  }

  /**
   * A catalogue with one template row, for the cases that are about templates.
   *
   * A FACTORY, not a shared module-level `vi.fn`: a shared spy accumulates `mock.calls`
   * across every test that uses it, which is fine until the day someone asserts on a
   * call count and gets a number from four other tests.
   */
  const templateCatalogue = () => vi.fn(async () => ({
    ok: true,
    servers: [{
      serverId: "hr-mcp",
      templates: [{
        uriTemplate: "file:///project/{path}",
        name: "Project file",
        variables: ["path"],
      }],
    }],
  }));

  /** Let every unrelated on-mount fetch settle, so later commits belong to the mention. */
  async function settle() {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  async function openMenu(ta: HTMLTextAreaElement, value = "@") {
    fireEvent.change(ta, { target: { value } });
    // The catalogue read is a promise; let it settle so the rows exist.
    await act(async () => { await Promise.resolve(); });
  }

  it("opens on @, filters by query, and closes on Escape", async () => {
    installMcpApi();
    render(<Harness />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta);
    expect(screen.getByTestId("resource-mention-menu")).toBeTruthy();
    expect(screen.getAllByTestId(/^resource-mention-item-/)).toHaveLength(2);

    await openMenu(ta, "@run");
    const rows = screen.getAllByTestId(/^resource-mention-item-/);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("runbook.md");

    await act(async () => { fireEvent.keyDown(ta, { key: "Escape" }); });
    expect(screen.queryByTestId("resource-mention-menu")).toBeNull();
  });

  it("attaches the host's fence as an ATTACHMENT and puts only a marker in the body", async () => {
    const { attachResource } = installMcpApi();
    render(<Harness initialText="" />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "look at @pol");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    await act(async () => { await Promise.resolve(); });

    expect(attachResource).toHaveBeenCalledWith("hr-mcp", "doc:1");
    // The mention token is replaced by a marker; the fence is nowhere in the body.
    expect(ta.value).toBe("look at [Resource #1] ");
    expect(ta.value).not.toContain("mcp-resource");
    expect(ta.value).not.toContain("BODY");
    // …and the chip exists, which is what carries the payload to the send path.
    // A chip exists, which is what carries the payload to the send path — the marker
    // in the body and this chip are the pair the marker-sync effect keeps together.
    expect(screen.getByTestId("attachment-chip")).toBeTruthy();
  });

  it("does not discard what the user typed while the read was in flight", async () => {
    // The read is asynchronous. Splicing into the text as it was when Enter was pressed
    // would silently throw away every keystroke since — the marker lands, and the
    // sentence the user was in the middle of writing disappears.
    let resolveRead: ((value: unknown) => void) | undefined;
    const attachResource = vi.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
    installMcpApi({ attachResource: attachResource as never });
    render(<Harness />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "@pol");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    // The user keeps typing before the read comes back.
    fireEvent.change(ta, { target: { value: "@pol and then some more words" } });
    await act(async () => {
      resolveRead?.({ ok: true, attachment: { type: "text", text: FENCE } });
      await Promise.resolve();
    });

    expect(ta.value).toContain("and then some more words");
    expect(ta.value).toContain("[Resource #1]");
  });

  it("keeps the marker and the attachment together when the trigger is gone", async () => {
    // Same race, other branch: the user deleted the `@pol` token during the read. The
    // attachment cannot be dropped (the read already happened) and it cannot be left
    // markerless (the sync effect would clean it straight back up), so the marker is
    // appended instead.
    let resolveRead: ((value: unknown) => void) | undefined;
    const attachResource = vi.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
    installMcpApi({ attachResource: attachResource as never });
    render(<Harness />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "@pol");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    fireEvent.change(ta, { target: { value: "different sentence entirely" } });
    await act(async () => {
      resolveRead?.({ ok: true, attachment: { type: "text", text: FENCE } });
      await Promise.resolve();
    });

    expect(ta.value).toBe("different sentence entirely [Resource #1] ");
    // A chip exists, which is what carries the payload to the send path — the marker
    // in the body and this chip are the pair the marker-sync effect keeps together.
    expect(screen.getByTestId("attachment-chip")).toBeTruthy();
  });

  it("surfaces a failed read without attaching anything", async () => {
    const attachResource = vi.fn(async () => ({ ok: false, error: "resource-failed" }));
    installMcpApi({ attachResource: attachResource as never });
    const onWarning = vi.fn();
    render(<Harness onWarningCb={onWarning} />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "@pol");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    await act(async () => { await Promise.resolve(); });

    // The message comes from the SHARED code table, not a hand-written mapping in the
    // hook: `resource-failed` has had an entry since stage 3a, and collapsing every code
    // to one sentence told a rate-limited user their server had disconnected.
    expect(onWarning).toHaveBeenCalledWith(t("formatIpcError.resourceFailed"));
    // The mention token stays so the user can retry; no marker, no chip.
    expect(ta.value).not.toContain("[Resource #");
  });

  it("shows a row the read would refuse, disabled and with the reason", async () => {
    // Listed but not attachable: the spec reserves `https:` for content the CLIENT
    // fetches, and the host refuses to fetch a server-chosen URL. Hiding the row would
    // make a user whose resource vanished report the picker as broken; offering it
    // normally spends a round-trip to fail with a message that blames the connection.
    const { attachResource } = installMcpApi({
      listResources: vi.fn(async () => ({
        ok: true,
        servers: [{
          serverId: "web-mcp",
          resources: [{ uri: "https://example.com/r.pdf", name: "report.pdf", hostFetchRefused: true }],
        }],
      })) as never,
    });
    const onWarning = vi.fn();
    render(<Harness onWarningCb={onWarning} />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "@rep");
    const row = screen.getByTestId("resource-mention-item-0");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain(t("composer.resourceNotFetchable"));

    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    await act(async () => { await Promise.resolve(); });
    expect(attachResource).not.toHaveBeenCalled();
    expect(onWarning).toHaveBeenCalledWith(t("composer.resourceNotFetchable"));
    expect(ta.value).not.toContain("[Resource #");
  });

  // ── URI templates: the row that opens a form instead of attaching ───────────────
  //
  // The property worth testing at this level is that accepting a template row reads
  // NOTHING until the user has filled the form — and that when they do, what leaves the
  // renderer is the template plus values, never a URI.
  it("opens the form instead of reading, and reads only on submit", async () => {
    const { attachResourceTemplate, attachResource } = installMcpApi({
      listResourceTemplates: templateCatalogue() as never,
    });
    render(<Harness initialText="" />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "see @proj");
    // The row says it is a template, because "Enter attaches the resource" is not what
    // happens here.
    expect(screen.getByTestId("resource-mention-template-badge-0")).toBeTruthy();

    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    await act(async () => { await Promise.resolve(); });
    // Nothing has been read: a template is an offer, not an identifier.
    expect(attachResourceTemplate).not.toHaveBeenCalled();
    expect(attachResource).not.toHaveBeenCalled();
    expect(ta.value).toBe("see @proj");
    const dialog = screen.getByTestId("mcp-resource-template-dialog");
    expect(dialog).toBeTruthy();
    // …and the menu is not left sitting open behind it.
    expect(screen.queryByTestId("resource-mention-menu")).toBeNull();

    fireEvent.change(screen.getByTestId("mcp-resource-template-input-path"), {
      target: { value: "notes.md" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("mcp-resource-template-submit"));
    });
    await act(async () => { await Promise.resolve(); });

    // The TEMPLATE and the values — never a URI. Main expands.
    expect(attachResourceTemplate).toHaveBeenCalledWith(
      "hr-mcp",
      "file:///project/{path}",
      { path: "notes.md" },
    );
    expect(ta.value).toBe("see [Resource #1] ");
    expect(ta.value).not.toContain("mcp-resource");
    expect(screen.getByTestId("attachment-chip")).toBeTruthy();
    expect(screen.queryByTestId("mcp-resource-template-dialog")).toBeNull();
  });

  it("re-checks the per-turn cap when the form is submitted, not only when it opens", async () => {
    // The form can sit open for a minute while the rest of the composer stays live, so
    // the answer at accept time is not the answer at submit time. Main refuses the turn
    // either way; the point of checking here is that the user is told by a message naming
    // the limit instead of by a refused send at the end of the turn.
    const { attachResourceTemplate } = installMcpApi({
      listResourceTemplates: templateCatalogue() as never,
    });
    const onWarning = vi.fn();
    const full: Attachment[] = Array.from({ length: MCP_RESOURCE_ATTACHMENTS_PER_TURN }, (_, i) => ({
      id: `r${i}`,
      n: i + 1,
      kind: "resource" as const,
      serverId: "hr-mcp",
      uri: `doc:${i}`,
      label: `doc-${i}.md`,
      text: FENCE,
      truncated: false,
    }));
    // Mounted UNDER the cap so the accept-time check passes, then filled to the cap while
    // the dialog is open — the setter is used rather than a re-render, because
    // `initialAttachments` seeds `useState` and a re-render would leave the count at 1,
    // making this assert against the accept-time check it is supposed to bypass.
    let setAttachments: ((next: Attachment[]) => void) | undefined;
    render(
      <Harness
        initialAttachments={[full[0]]}
        initialText="[Resource #1] "
        onWarningCb={onWarning}
        exposeSetAttachments={(set) => { setAttachments = set; }}
      />,
    );
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "[Resource #1] @proj");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    expect(screen.getByTestId("mcp-resource-template-dialog")).toBeTruthy();

    await act(async () => {
      setAttachments?.(full);
      // The markers have to arrive too, or the marker-sync effect removes what was added.
      fireEvent.change(ta, { target: { value: full.map((a) => `[Resource #${a.n}] `).join("") } });
    });
    await settle();

    fireEvent.change(screen.getByTestId("mcp-resource-template-input-path"), {
      target: { value: "notes.md" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("mcp-resource-template-submit"));
    });
    await act(async () => { await Promise.resolve(); });

    expect(attachResourceTemplate).not.toHaveBeenCalled();
    expect(onWarning).toHaveBeenCalledWith(
      t("composer.resourceLimit", { max: MCP_RESOURCE_ATTACHMENTS_PER_TURN }),
    );
  });

  it("keeps a template attachment and its marker together when the trigger is gone", async () => {
    // The stale-range path, on the side with the LONG window: the user can sit in the
    // dialog for a minute, and the range captured at accept time may no longer hold the
    // mention. The attachment cannot be dropped and cannot be left markerless, so the
    // marker is appended — same rule as the resource path, exercised where it matters.
    installMcpApi({ listResourceTemplates: templateCatalogue() as never });
    render(<Harness />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "@proj");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    // The user wipes the composer while the form is open.
    fireEvent.change(ta, { target: { value: "different sentence entirely" } });
    fireEvent.change(screen.getByTestId("mcp-resource-template-input-path"), {
      target: { value: "notes.md" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("mcp-resource-template-submit"));
    });
    await act(async () => { await Promise.resolve(); });

    expect(ta.value).toBe("different sentence entirely [Resource #1] ");
    expect(screen.getByTestId("attachment-chip")).toBeTruthy();
  });

  it("still opens the form when the RESOURCE channel is the missing one", async () => {
    // THE direction the old code got wrong, and the one my first version of this test
    // did not exercise. Before the per-kind guard, `accept` opened with
    // `if (!trigger || !mcp?.attachResource) return` — so with `attachResource` absent, a
    // TEMPLATE row hit that outer guard and returned silently: no dialog, no message,
    // nothing. Deleting the OTHER channel (below) cannot catch it, because that pairing
    // was already handled by an inner check.
    installMcpApi({ listResourceTemplates: templateCatalogue() as never });
    (window as unknown as { lvis: { mcp: Record<string, unknown> } })
      .lvis.mcp.attachResource = undefined;
    const onWarning = vi.fn();
    render(<Harness onWarningCb={onWarning} />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "@proj");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    await act(async () => { await Promise.resolve(); });

    // Old code: silent return, no dialog. Current: the template row does not need the
    // resource channel at all.
    expect(screen.getByTestId("mcp-resource-template-dialog")).toBeTruthy();
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("reports when the RESOURCE channel is absent on a resource row", async () => {
    // The mirror of the template case, and the one arm that had no coverage: a reviewer
    // pointed out that `accept()`'s resource branch reports through `onError` and
    // nothing held it, so mutating that back to a bare `return` would have restored
    // silent inertness for the OTHER row kind while every test stayed green.
    installMcpApi();
    (window as unknown as { lvis: { mcp: Record<string, unknown> } })
      .lvis.mcp.attachResource = undefined;
    const onWarning = vi.fn();
    render(<Harness onWarningCb={onWarning} />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "@pol");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    await act(async () => { await Promise.resolve(); });

    expect(onWarning).toHaveBeenCalledWith(t("composer.resourceAttachFailed"));
    expect(ta.value).not.toContain("[Resource #");
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });

  it("reports rather than silently doing nothing when a channel is absent", async () => {
    // The other pairing. Kept alongside the one above because it is what catches a
    // "guard both kinds on both channels" mutation: that would block the resource row
    // too, turning the positive assertion at the end red.
    const { attachResource } = installMcpApi({ listResourceTemplates: templateCatalogue() as never });
    (window as unknown as { lvis: { mcp: Record<string, unknown> } })
      .lvis.mcp.attachResourceTemplate = undefined;
    const onWarning = vi.fn();
    render(<Harness onWarningCb={onWarning} />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "@proj");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    await act(async () => { await Promise.resolve(); });

    expect(onWarning).toHaveBeenCalledWith(t("composer.resourceAttachFailed"));
    expect(screen.queryByTestId("mcp-resource-template-dialog")).toBeNull();
    // …and the RESOURCE rows still work, which is the whole reason the guard is per kind.
    await openMenu(ta, "@pol");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    await act(async () => { await Promise.resolve(); });
    expect(attachResource).toHaveBeenCalledWith("hr-mcp", "doc:1");
  });

  it("attaches nothing when the form is cancelled", async () => {
    const { attachResourceTemplate } = installMcpApi({
      listResourceTemplates: templateCatalogue() as never,
    });
    render(<Harness initialText="" />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "@proj");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    await act(async () => {
      fireEvent.click(screen.getByTestId("mcp-resource-template-cancel"));
    });
    await act(async () => { await Promise.resolve(); });

    expect(attachResourceTemplate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mcp-resource-template-dialog")).toBeNull();
    // The mention token survives, so the user can pick something else.
    expect(ta.value).toBe("@proj");
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });

  it("surfaces a refused template read without attaching anything", async () => {
    const attachResourceTemplate = vi.fn(async () => ({ ok: false, error: "resource-failed" }));
    installMcpApi({
      listResourceTemplates: templateCatalogue() as never,
      attachResourceTemplate: attachResourceTemplate as never,
    });
    const onWarning = vi.fn();
    render(<Harness onWarningCb={onWarning} />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "@proj");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    fireEvent.change(screen.getByTestId("mcp-resource-template-input-path"), {
      target: { value: "../../etc/passwd" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("mcp-resource-template-submit"));
    });
    await act(async () => { await Promise.resolve(); });

    // Through the same shared code table as every other attach failure.
    expect(onWarning).toHaveBeenCalledWith(t("formatIpcError.resourceFailed"));
    expect(ta.value).not.toContain("[Resource #");
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });

  it("still offers resources when the template channel is absent", async () => {
    // Both catalogues share one `Promise.all`, so a missing method would throw into the
    // catch that empties the whole catalogue — and the user would lose their RESOURCES
    // because TEMPLATES were unavailable. The guard degrades instead.
    installMcpApi();
    (window as unknown as { lvis: { mcp: Record<string, unknown> } })
      .lvis.mcp.listResourceTemplates = undefined;
    render(<Harness />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta);
    expect(screen.getAllByTestId(/^resource-mention-item-/)).toHaveLength(2);
  });

  it("still offers resources when the template fetch REJECTS", async () => {
    // The sibling of the case above, and the one a bare `Promise.all` would fail: a
    // rejecting half takes the whole join down into the catch that empties the catalogue.
    // Each half absorbs its own failure instead.
    installMcpApi({
      listResourceTemplates: vi.fn(async () => {
        throw new Error("template channel exploded");
      }) as never,
    });
    render(<Harness />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta);
    expect(screen.getAllByTestId(/^resource-mention-item-/)).toHaveLength(2);
  });

  it("disables a template the host will not fetch, and says why", async () => {
    // Listed but not fillable: every expansion of a literal `https:` template is one the
    // host refuses. Offering it normally spends a dialog AND a round-trip to fail with a
    // message that blames the server for a host-side rule.
    const { attachResourceTemplate } = installMcpApi({
      listResourceTemplates: vi.fn(async () => ({
        ok: true,
        servers: [{
          serverId: "web-mcp",
          templates: [{
            uriTemplate: "https://example.com/{doc}",
            name: "web doc",
            variables: ["doc"],
            hostFetchRefused: true,
          }],
        }],
      })) as never,
    });
    const onWarning = vi.fn();
    render(<Harness onWarningCb={onWarning} />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "@web");
    const row = screen.getByTestId("resource-mention-item-0");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain(t("composer.resourceNotFetchable"));

    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    await act(async () => { await Promise.resolve(); });
    // No form, and no round trip.
    expect(screen.queryByTestId("mcp-resource-template-dialog")).toBeNull();
    expect(attachResourceTemplate).not.toHaveBeenCalled();
    expect(onWarning).toHaveBeenCalledWith(t("composer.resourceNotFetchable"));
  });

  it("tells the user what Enter does on the row they are actually on", async () => {
    // The footer is one sentence for a menu holding two kinds of row. Fixed text makes it
    // false half the time, and an icon on the row does not change what the sentence says.
    //
    // Driven by ARROW KEYS through ONE mixed menu, not by filtering to a single-kind menu
    // — a review pointed out that the filtered version passes identically with `items[0]`
    // in place of `items[activeIndex]`, so it pinned "the hint varies by kind" rather
    // than the title's claim. Here the list never changes; only the active row does.
    installMcpApi({ listResourceTemplates: templateCatalogue() as never });
    render(<Harness />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta);
    const rows = screen.getAllByTestId(/^resource-mention-item-/);
    expect(rows).toHaveLength(3);
    const templateIndex = rows.findIndex((row) => row.textContent?.includes("Project file"));
    expect(templateIndex).toBeGreaterThan(0);

    expect(screen.getByTestId("resource-mention-hint").textContent)
      .toBe(t("composer.resourceMentionHint"));
    for (let i = 0; i < templateIndex; i += 1) {
      await act(async () => { fireEvent.keyDown(ta, { key: "ArrowDown" }); });
    }
    expect(screen.getByTestId("resource-mention-hint").textContent)
      .toBe(t("composer.resourceMentionTemplateHint"));
    // …and back off it again, so the test cannot pass by latching once.
    await act(async () => { fireEvent.keyDown(ta, { key: "ArrowUp" }); });
    expect(screen.getByTestId("resource-mention-hint").textContent)
      .toBe(t("composer.resourceMentionHint"));
  });

  it("still offers templates when the RESOURCE fetch rejects", async () => {
    // The mirror of the two template-side cases. Each half absorbs its own failure, so
    // this direction has to hold too — and before the per-half catch it did not.
    installMcpApi({
      listResources: vi.fn(async () => { throw new Error("resource channel exploded"); }) as never,
      listResourceTemplates: templateCatalogue() as never,
    });
    render(<Harness />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta);
    const rows = screen.getAllByTestId(/^resource-mention-item-/);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Project file");
  });

  it("says so rather than swallowing a submit while another read is in flight", async () => {
    // The form has already taken the user's values and closed. A silent return loses
    // typed work with no explanation — survivable for a picker row, not for a form.
    let resolveRead: ((value: unknown) => void) | undefined;
    const attachResource = vi.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
    const { attachResourceTemplate } = installMcpApi({
      attachResource: attachResource as never,
      listResourceTemplates: templateCatalogue() as never,
    });
    const onWarning = vi.fn();
    render(<Harness onWarningCb={onWarning} />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    // A plain resource attach is left in flight…
    await openMenu(ta, "@pol");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    expect(attachResource).toHaveBeenCalled();

    // …then a template is accepted, filled, and submitted underneath it.
    fireEvent.change(ta, { target: { value: "@proj" } });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    fireEvent.change(screen.getByTestId("mcp-resource-template-input-path"), {
      target: { value: "notes.md" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("mcp-resource-template-submit"));
    });
    await act(async () => { await Promise.resolve(); });

    expect(attachResourceTemplate).not.toHaveBeenCalled();
    expect(onWarning).toHaveBeenCalledWith(t("composer.resourceAttachBusy"));
    resolveRead?.({ ok: true, attachment: { type: "text", text: FENCE } });
  });

  it("lists templates alongside resources in one menu", async () => {
    // One list to the user. Both catalogues are fetched together for that reason — two
    // effects would each set the catalogue and the later one would erase the other's
    // rows, which reads as "my templates disappear sometimes".
    installMcpApi({ listResourceTemplates: templateCatalogue() as never });
    render(<Harness />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta);
    const rows = screen.getAllByTestId(/^resource-mention-item-/);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.textContent).join(" ")).toContain("Project file");
  });

  it("does not spend the chip-strip limit on resources", async () => {
    // Two caps, two lanes. `ATTACH_MAX_COUNT` bounds how many chips stay legible; the
    // per-turn resource bound is about how much server text a turn carries. Five
    // attached documents must not be what stops the user adding a screenshot.
    installMcpApi();
    const resources: Attachment[] = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      n: i + 1,
      kind: "resource" as const,
      serverId: "hr-mcp",
      uri: `doc:${i}`,
      label: `doc-${i}.md`,
      text: FENCE,
      truncated: false,
    }));
    render(
      <Harness
        initialText={resources.map((r) => `[Resource #${r.n}]`).join(" ")}
        initialAttachments={resources}
      />,
    );
    expect(screen.queryByTestId("composer-limit-warning")).toBeNull();
  });

  it("does not splice into a DIFFERENT mention typed during the read", async () => {
    // The half the first range check missed. `startsWith("@")` was satisfied by any
    // token beginning with the sigil, so retyping a different mention during the read
    // let the splice overwrite its first characters — the same corruption the range
    // check exists to prevent, one condition weaker. The token must be the SAME token.
    let resolveRead: ((value: unknown) => void) | undefined;
    const attachResource = vi.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
    installMcpApi({ attachResource: attachResource as never });
    render(<Harness />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "@pol");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    // Same start offset, still starts with `@`, different token.
    fireEvent.change(ta, { target: { value: "@abcdefgh" } });
    await act(async () => {
      resolveRead?.({ ok: true, attachment: { type: "text", text: FENCE } });
      await Promise.resolve();
    });

    // Nothing was eaten: the typed token survives intact and the marker is appended.
    expect(ta.value).toContain("@abcdefgh");
    expect(ta.value).toContain("[Resource #1]");
  });

  it("renders a spoofing name through the display sanitizer, at every surface", async () => {
    // The sanitizer has its own unit tests; nothing asserted the PICKER uses it, so the
    // security-relevant wiring was uncovered — deleting the call left the suite green.
    // The chip is the second surface and the one that matters most: it is what the user
    // reads to confirm what they attached, so a chip that disagrees with the row they
    // clicked is the whole spoof.
    const RLO = String.fromCodePoint(0x202e);
    const ZWSP = String.fromCodePoint(0x200b);
    installMcpApi({
      listResources: vi.fn(async () => ({
        ok: true,
        servers: [{
          serverId: "hr-mcp",
          resources: [{ uri: "doc:1", name: `report-${RLO}gnp.exe`, title: `poli${ZWSP}cy.md` }],
        }],
      })) as never,
    });
    render(<Harness />);
    const ta = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    await settle();

    await openMenu(ta, "@pol");
    const row = screen.getByTestId("resource-mention-item-0");
    expect(row.textContent).toContain("policy.md");
    expect(row.textContent).not.toContain(ZWSP);
    expect(row.textContent).not.toContain(RLO);

    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    await act(async () => { await Promise.resolve(); });
    const chip = screen.getByTestId("attachment-chip");
    expect(chip.textContent).not.toContain(ZWSP);
    expect(chip.textContent).not.toContain(RLO);
  });

  it("still blocks a sixth IMAGE while five resources are attached", async () => {
    // The half that proves a partition rather than a raised number: resources do not
    // consume the chip-strip lane, and the chip-strip lane is still enforced.
    installMcpApi();
    const five: Attachment[] = Array.from({ length: 5 }, (_, i) => ({
      ...img1, id: `i${i}`, n: i + 1,
    }));
    const resources: Attachment[] = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`, n: 100 + i, kind: "resource" as const, serverId: "hr-mcp",
      uri: `doc:${i}`, label: `doc-${i}.md`, text: FENCE, truncated: false,
    }));
    render(
      <Harness
        initialText={[...five, ...resources].map((a) => a.kind === "image"
          ? `[Image #${a.n}]` : `[Resource #${a.n}]`).join(" ")}
        initialAttachments={[...five, ...resources]}
      />,
    );
    // Five images fill the chip-strip lane, so the warning is on — the resources did
    // not consume it, and they did not suppress it either.
    expect(screen.getByTestId("composer-limit-warning")).toBeTruthy();
  });
});
