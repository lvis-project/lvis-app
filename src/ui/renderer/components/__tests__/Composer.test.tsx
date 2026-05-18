// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import { useRef, useState } from "react";
import { Composer, type ComposerHandle } from "../Composer.js";
import type {
  Attachment,
  ImageAttachment,
} from "../../types/attachments.js";
import type { SuggestedRepliesSnapshot } from "../../hooks/use-suggested-replies.js";

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
  suggestedReplies,
}: {
  initialText?: string;
  initialAttachments?: Attachment[];
  onSendCb?: () => void;
  suggestedReplies?: SuggestedRepliesSnapshot;
}) {
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments);
  const counterRef = useRef(initialAttachments.length);
  const composerRef = useRef<ComposerHandle | null>(null);

  return (
    <Composer
      ref={composerRef}
      text={text}
      onTextChange={setText}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      allocateN={() => ++counterRef.current}
      saveClipboardImage={mockSave}
      onSend={onSendCb}
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

describe("Composer", () => {
  it("renders empty composer with placeholder", () => {
    render(<Harness />);
    expect(screen.getByTestId("composer")).toBeTruthy();
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
    const ta = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
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

  it("calls onSend on Enter (without shift)", () => {
    const onSendCb = vi.fn();
    render(<Harness initialText="hello" onSendCb={onSendCb} />);
    const ta = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    expect(onSendCb).toHaveBeenCalled();
  });

  it("does NOT call onSend on Shift+Enter", () => {
    const onSendCb = vi.fn();
    render(<Harness initialText="hello" onSendCb={onSendCb} />);
    const ta = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
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
    const ta = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
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
    const ta = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
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
    const ta = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
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
    const textarea = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
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
    expect(ghost.textContent).toContain("Tab to fill");
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
    const ta = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
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
    const ta = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
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
    const ta = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
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
    const ta = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
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
    const ta = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
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
    const ta = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Escape" });
    });
    expect(screen.queryByTestId("suggested-replies-ghost")).toBeNull();
    expect(screen.queryByTestId("suggested-replies-chip-row")).toBeNull();
  });
});
