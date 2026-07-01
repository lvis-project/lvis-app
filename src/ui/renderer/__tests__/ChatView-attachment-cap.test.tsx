/**
 * Behavior-lock tests for ChatView.handleAttach's 5-attachment cap.
 *
 * C13 pre-decomposition lock (C15 will move handleAttach into a hook). These
 * capture the CURRENT observable behavior of the atomic flushSync commit:
 * when a single native openFile() returns MORE candidates than the remaining
 * capacity, only the first ATTACH_MAX_COUNT (5) are committed and the overflow
 * is dropped — the 6th never becomes an attachment nor a textarea marker.
 *
 * Harness conventions copied from ChatView.test.tsx (renderApp through <App />,
 * window.lvis.attach reassigned after render, iab-attach-button click).
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { ATTACH_MAX_COUNT } from "../types/attachments.js";

type AttachMock = {
  openFile: ReturnType<typeof vi.fn>;
  readImage: ReturnType<typeof vi.fn>;
  saveClipboardImage: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
};

function installAttachMock(fileCount: number): AttachMock {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    path: `C:\\workspace\\attach-${i}.md`,
    name: `attach-${i}.md`,
    ext: "md",
    bytes: 100 + i,
    isImage: false,
  }));
  const attach: AttachMock = {
    openFile: vi.fn(async () => ({ canceled: false, rejected: [], files })),
    readImage: vi.fn(async () => ({ ok: false, error: "not image" })),
    saveClipboardImage: vi.fn(async () => ({ ok: false })),
    openExternal: vi.fn(async () => ({ ok: true })),
  };
  (window.lvis as unknown as { attach: AttachMock }).attach = attach;
  return attach;
}

describe("ChatView attachment 5-cap (handleAttach)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("commits only the first 5 attachments when a single openFile returns 6 (6th dropped)", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    installAttachMock(6);

    await waitFor(() => {
      expect(container.querySelector('[data-testid="iab-attach-button"]')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="iab-attach-button"]')!);
    });

    // 5 accepted → 2+ attachments render the stacked collapsed chip whose
    // badge reads "<count>/<max>" plus " full" at the cap.
    const badge = await waitFor(() => {
      const el = container.querySelector('[data-testid="chip-count-badge"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(badge.textContent).toContain(`${ATTACH_MAX_COUNT}/${ATTACH_MAX_COUNT}`);
    expect(badge.textContent).toContain("full");

    // Markers #1..#5 landed in the composer body; the dropped 6th did not.
    const textarea = container.querySelector(
      '[data-testid="composer-textarea"]',
    ) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    for (let n = 1; n <= ATTACH_MAX_COUNT; n++) {
      expect(textarea.value).toContain(`[File #${n}]`);
    }
    expect(textarea.value).not.toContain(`[File #${ATTACH_MAX_COUNT + 1}]`);
  });

  it("commits all attachments unchanged when the count is at the cap (exactly 5)", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    installAttachMock(ATTACH_MAX_COUNT);

    await waitFor(() => {
      expect(container.querySelector('[data-testid="iab-attach-button"]')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="iab-attach-button"]')!);
    });

    const badge = await waitFor(() => {
      const el = container.querySelector('[data-testid="chip-count-badge"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(badge.textContent).toContain(`${ATTACH_MAX_COUNT}/${ATTACH_MAX_COUNT}`);
    expect(badge.textContent).toContain("full");

    const textarea = container.querySelector(
      '[data-testid="composer-textarea"]',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toContain(`[File #${ATTACH_MAX_COUNT}]`);
    expect(textarea.value).not.toContain(`[File #${ATTACH_MAX_COUNT + 1}]`);
  });
});
