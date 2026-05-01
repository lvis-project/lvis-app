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
}: {
  initialText?: string;
  initialAttachments?: Attachment[];
  onSendCb?: () => void;
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

  it("send button is disabled when text empty and no attachments", () => {
    render(<Harness />);
    const send = screen.getByTestId("composer-send-button") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });
});
