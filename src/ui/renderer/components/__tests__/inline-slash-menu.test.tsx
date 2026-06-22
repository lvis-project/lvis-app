// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { useRef, useState } from "react";
import { Composer, type ComposerHandle } from "../Composer.js";
import type { Attachment } from "../../types/attachments.js";
import type { QuickAction } from "../command-actions.js";

const mockSave = vi.fn(async () => ({ ok: true }));

function Harness({
  actions = [],
  onSelectPlugin = vi.fn(),
  onSendCb = vi.fn(),
}: {
  actions?: QuickAction[];
  onSelectPlugin?: (k: string) => void;
  onSendCb?: () => void;
}) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const composerRef = useRef<ComposerHandle | null>(null);
  return (
    <Composer
      ref={composerRef}
      text={text}
      onTextChange={setText}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      allocateN={() => 1}
      saveClipboardImage={mockSave}
      onSend={onSendCb}
      commandActions={actions}
      inlinePlugins={[]}
      onSelectPlugin={onSelectPlugin}
    />
  );
}

/** Type a value and place the caret at the end so the trigger detector sees it. */
function typeInto(ta: HTMLTextAreaElement, value: string) {
  fireEvent.change(ta, { target: { value } });
  ta.setSelectionRange(value.length, value.length);
  fireEvent.keyUp(ta, { key: value.slice(-1) });
}

describe("inline / autocomplete in the composer", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("opens the menu when typing a leading slash", () => {
    const { getByTestId, queryByTestId } = render(<Harness />);
    const ta = getByTestId("composer-textarea") as HTMLTextAreaElement;
    expect(queryByTestId("inline-slash-menu")).toBeNull();
    act(() => typeInto(ta, "/se"));
    expect(getByTestId("inline-slash-menu")).toBeTruthy();
  });

  it("does NOT open the menu for a URL slash (https://)", () => {
    const { getByTestId, queryByTestId } = render(<Harness />);
    const ta = getByTestId("composer-textarea") as HTMLTextAreaElement;
    act(() => typeInto(ta, "see https://x"));
    expect(queryByTestId("inline-slash-menu")).toBeNull();
  });

  it("Enter accepts the highlighted command and inserts it (does not send)", () => {
    const onSendCb = vi.fn();
    const { getByTestId } = render(<Harness onSendCb={onSendCb} />);
    const ta = getByTestId("composer-textarea") as HTMLTextAreaElement;
    act(() => typeInto(ta, "/sess"));
    expect(getByTestId("inline-slash-menu")).toBeTruthy();
    act(() => {
      fireEvent.keyDown(ta, { key: "Enter" });
    });
    // The /sessions command spliced in with a trailing space; no send fired.
    expect(ta.value.startsWith("/sessions ")).toBe(true);
    expect(onSendCb).not.toHaveBeenCalled();
  });

  it("Escape dismisses the menu", () => {
    const { getByTestId, queryByTestId } = render(<Harness />);
    const ta = getByTestId("composer-textarea") as HTMLTextAreaElement;
    act(() => typeInto(ta, "/se"));
    expect(getByTestId("inline-slash-menu")).toBeTruthy();
    act(() => {
      fireEvent.keyDown(ta, { key: "Escape" });
    });
    expect(queryByTestId("inline-slash-menu")).toBeNull();
  });

  it("runs a view shortcut and strips the slash token", () => {
    const run = vi.fn();
    const actions: QuickAction[] = [{ id: "home", label: "홈으로", run }];
    const { getByTestId } = render(<Harness actions={actions} />);
    const ta = getByTestId("composer-textarea") as HTMLTextAreaElement;
    // Query that matches only the shortcut, not any built-in command.
    act(() => typeInto(ta, "/홈"));
    expect(getByTestId("inline-slash-menu")).toBeTruthy();
    act(() => {
      fireEvent.keyDown(ta, { key: "Enter" });
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(ta.value).toBe("");
  });
});
