// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { handleClipboardPaste } from "../clipboard-paste.js";

function makePasteEvent({
  text = "",
  imageBlob = null as Blob | null,
}): ClipboardEvent {
  const items: Partial<DataTransferItem>[] = [];
  if (text) {
    items.push({
      kind: "string",
      type: "text/plain",
      getAsFile: () => null,
    });
  }
  if (imageBlob) {
    items.push({
      kind: "file",
      type: imageBlob.type,
      getAsFile: () => imageBlob as File,
    });
  }
  const itemList = Object.assign([...items], {
    length: items.length,
  }) as unknown as DataTransferItemList;
  return {
    clipboardData: {
      items: itemList,
      getData: (kind: string) => (kind === "text/plain" ? text : ""),
    } as unknown as DataTransfer,
  } as ClipboardEvent;
}

const mockSaveOk = async (b64: string) => ({
  ok: true,
  path: "/tmp/lvis-clip-x.png",
  width: 100,
  height: 80,
  bytes: 1024,
  mimeType: "image/png",
  dataUrl: `data:image/png;base64,${b64}`,
});

describe("handleClipboardPaste", () => {
  it("ignores short text paste (handled=false)", async () => {
    const ev = makePasteEvent({ text: "hello" });
    const outcome = await handleClipboardPaste(ev, {
      count: 0,
      allocateN: () => 1,
      saveClipboardImage: mockSaveOk,
      max: 5,
    });
    expect(outcome.handled).toBe(false);
  });

  it("chips long text (>=50 chars)", async () => {
    const longText = "x".repeat(60);
    const ev = makePasteEvent({ text: longText });
    const allocate = vi.fn(() => 7);
    const outcome = await handleClipboardPaste(ev, {
      count: 0,
      allocateN: allocate,
      saveClipboardImage: mockSaveOk,
      max: 5,
    });
    expect(outcome.handled).toBe(true);
    expect(allocate).toHaveBeenCalled();
    expect(outcome.newAttachment?.kind).toBe("paste");
    expect(outcome.insertText).toContain("[Pasted text #7 +1 lines]");
  });

  it("chips multi-newline text (>=3 newlines)", async () => {
    const multiline = "a\nb\nc\nd";
    const ev = makePasteEvent({ text: multiline });
    const outcome = await handleClipboardPaste(ev, {
      count: 0,
      allocateN: () => 1,
      saveClipboardImage: mockSaveOk,
      max: 5,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.newAttachment?.kind).toBe("paste");
  });

  it("creates image attachment when image is on clipboard", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const ev = makePasteEvent({ imageBlob: blob });
    const outcome = await handleClipboardPaste(ev, {
      count: 0,
      allocateN: () => 4,
      saveClipboardImage: mockSaveOk,
      max: 5,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.newAttachment?.kind).toBe("image");
    expect(outcome.insertText).toBe("[Image #4] ");
  });

  it("rejects when at MAX with image paste", async () => {
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    const ev = makePasteEvent({ imageBlob: blob });
    const outcome = await handleClipboardPaste(ev, {
      count: 5,
      allocateN: () => 99,
      saveClipboardImage: mockSaveOk,
      max: 5,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.newAttachment).toBeUndefined();
    expect(outcome.warning).toBeTruthy();
  });

  it("allows short-text paste even at MAX", async () => {
    const ev = makePasteEvent({ text: "hi" });
    const outcome = await handleClipboardPaste(ev, {
      count: 5,
      allocateN: () => 99,
      saveClipboardImage: mockSaveOk,
      max: 5,
    });
    expect(outcome.handled).toBe(false);
  });

  it("emits warning when saveClipboardImage fails", async () => {
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    const ev = makePasteEvent({ imageBlob: blob });
    const outcome = await handleClipboardPaste(ev, {
      count: 0,
      allocateN: () => 1,
      saveClipboardImage: async () => ({ ok: false, error: "disk full" }),
      max: 5,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.newAttachment).toBeUndefined();
    expect(outcome.warning).toContain("disk full");
  });
});
