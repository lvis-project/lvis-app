// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen, within } from "@testing-library/react";
import {
  AttachmentChip,
  AttachmentChipCollapsed,
  AttachmentOverlay,
} from "../AttachmentChip.js";
import type {
  Attachment,
  ImageAttachment,
  FileAttachment,
  PasteAttachment,
} from "../../types/attachments.js";

const img1: ImageAttachment = {
  id: "i1",
  n: 1,
  kind: "image",
  path: "/tmp/clipboard-005935.png",
  mimeType: "image/png",
  width: 1280,
  height: 720,
  bytes: 234_000,
  dataUrl: "data:image/png;base64,xxx",
};
const file2: FileAttachment = {
  id: "f2",
  n: 2,
  kind: "file",
  path: "/Users/ken/Desktop/budget-2026.pdf",
  name: "budget-2026.pdf",
  ext: "pdf",
  bytes: 1_200_000,
};
const paste3: PasteAttachment = {
  id: "p3",
  n: 3,
  kind: "paste",
  text: "long text here..." + "\n".repeat(12),
  lines: 12,
  chars: 487,
};

describe("AttachmentChip (single)", () => {
  it("renders a single image chip with N/MAX badge", () => {
    render(<AttachmentChip attachment={img1} total={1} />);
    expect(screen.getByTestId("attachment-chip")).toBeTruthy();
    const badge = screen.getByTestId("chip-count-badge");
    expect(badge.textContent).toContain("#1");
    expect(badge.textContent).toContain("1/5");
  });

  it("uses warn class at total=4", () => {
    render(<AttachmentChip attachment={img1} total={4} />);
    const badge = screen.getByTestId("chip-count-badge");
    expect(badge.className).toMatch(/text-warning/);
  });

  it("uses full class at total=5", () => {
    render(<AttachmentChip attachment={img1} total={5} />);
    const badge = screen.getByTestId("chip-count-badge");
    expect(badge.className).toMatch(/destructive/);
  });

  it("renders file chip with collapsed name label", () => {
    render(<AttachmentChip attachment={file2} total={1} />);
    const badge = screen.getByTestId("chip-count-badge");
    expect(badge.textContent).toMatch(/budge|budg…/);
  });

  it("renders paste chip with line count label", () => {
    render(<AttachmentChip attachment={paste3} total={1} />);
    const badge = screen.getByTestId("chip-count-badge");
    expect(badge.textContent).toContain("+12 lines");
  });
});

describe("AttachmentChipCollapsed", () => {
  it("renders the stacked trigger with N/MAX", () => {
    const list: Attachment[] = [img1, file2];
    render(<AttachmentChipCollapsed attachments={list} />);
    expect(screen.getByTestId("attachment-chip-collapsed")).toBeTruthy();
    const badge = screen.getByTestId("chip-count-badge");
    expect(badge.textContent).toContain("2/5");
  });

  it("opens the overlay when the trigger is clicked", () => {
    const list: Attachment[] = [img1, file2, paste3];
    render(<AttachmentChipCollapsed attachments={list} />);
    fireEvent.click(screen.getByTestId("attachment-chip-collapsed"));
    expect(screen.getByTestId("attachment-overlay")).toBeTruthy();
    const items = screen.getAllByTestId("overlay-item");
    expect(items.length).toBe(3);
  });

  it("marks the badge as full at MAX", () => {
    const list: Attachment[] = [img1, img1, img1, img1, img1];
    render(<AttachmentChipCollapsed attachments={list} />);
    const badge = screen.getByTestId("chip-count-badge");
    expect(badge.className).toMatch(/destructive/);
    expect(badge.textContent).toContain("5/5");
  });

  it("renders the stack with layer count matching attachments.length", () => {
    for (const count of [2, 3, 4, 5] as const) {
      const list: Attachment[] = Array.from({ length: count }, (_, i) => ({
        ...img1,
        id: `i${i}`,
        n: i + 1,
      }));
      const { unmount } = render(<AttachmentChipCollapsed attachments={list} />);
      const stack = screen.getByTestId("chip-stack");
      expect(stack.getAttribute("data-layers")).toBe(String(count));
      unmount();
    }
  });
});

describe("AttachmentChip — single, clickable", () => {
  it("opens overlay on click and lists the single attachment", () => {
    render(<AttachmentChip attachment={img1} total={1} />);
    expect(screen.getByTestId("attachment-chip")).toBeTruthy();
    fireEvent.click(screen.getByTestId("attachment-chip"));
    expect(screen.getByTestId("attachment-overlay")).toBeTruthy();
    const items = screen.getAllByTestId("overlay-item");
    expect(items.length).toBe(1);
    expect(screen.getByText("Image #1")).toBeTruthy();
  });

  it("forwards onOpenExternal from the overlay's open button", () => {
    const onOpenExternal = vi.fn();
    render(
      <AttachmentChip
        attachment={file2}
        total={1}
        onOpenExternal={onOpenExternal}
      />,
    );
    fireEvent.click(screen.getByTestId("attachment-chip"));
    fireEvent.click(screen.getByTitle("기본 앱으로 열기"));
    expect(onOpenExternal).toHaveBeenCalledWith(file2.path);
  });
});

describe("AttachmentOverlay", () => {
  it("lists each attachment with its N label and collapsed path", () => {
    const list: Attachment[] = [img1, file2, paste3];
    render(<AttachmentOverlay attachments={list} />);
    expect(screen.getByText("Image #1")).toBeTruthy();
    expect(screen.getByText("File #2")).toBeTruthy();
    expect(screen.getByText("Pasted text #3")).toBeTruthy();
  });

  it("invokes onOpenExternal callback for non-paste items", () => {
    const onOpenExternal = vi.fn();
    const list: Attachment[] = [img1, file2, paste3];
    render(
      <AttachmentOverlay attachments={list} onOpenExternal={onOpenExternal} />,
    );
    const buttons = screen.getAllByTitle("기본 앱으로 열기");
    expect(buttons.length).toBe(2);
    fireEvent.click(buttons[0]);
    expect(onOpenExternal).toHaveBeenCalledWith(img1.path);
  });

  it("does not render open-external button for paste attachments", () => {
    const list: Attachment[] = [paste3];
    render(
      <AttachmentOverlay attachments={list} onOpenExternal={() => {}} />,
    );
    expect(screen.queryAllByTitle("기본 앱으로 열기").length).toBe(0);
  });

  it("renders empty list cleanly with header count = 0", () => {
    render(<AttachmentOverlay attachments={[]} />);
    const body = screen.getByTestId("attachment-overlay-body");
    expect(within(body).getByText("첨부 0개")).toBeTruthy();
  });
});
