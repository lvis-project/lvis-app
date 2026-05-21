/**
 * CompactedToolResult component tests.
 *
 * Covers state transitions:
 *   collapsed (default) → loading → expanded   (IPC success)
 *   collapsed           → loading → missing    (IPC returns null)
 *   collapsed           → loading → missing    (IPC throws — Major #1 fix)
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import { CompactedToolResult } from "../components/CompactedToolResult.js";

const STUB = "[tool_result stripped: tool=Read, origLen=1234]";
const SESSION_ID = "session-test-1";
const TOOL_USE_ID = "tu-test-1";

/** Build a minimal window.lvisApi stub with a controllable chatGetVerbatimToolResult. */
function makeApi(impl: () => Promise<{ content: string; lineCount: number } | null>) {
  return {
    chatGetVerbatimToolResult: vi.fn(impl),
  };
}

describe("CompactedToolResult", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders in collapsed state by default with char count hint from stub", () => {
    vi.stubGlobal("lvisApi", makeApi(() => Promise.resolve(null)));
    const { container } = render(
      <CompactedToolResult
        toolUseId={TOOL_USE_ID}
        toolName="Read"
        input={{ path: "/tmp/file.txt" }}
        stubContent={STUB}
        sessionId={SESSION_ID}
      />,
    );
    expect(container.textContent).toContain("▶");
    expect(container.textContent).toContain("[펼치기]");
    expect(container.textContent).toContain("Read");
    // char count hint from origLen=1234
    expect(container.textContent).toContain("1.2K chars");
  });

  it("transitions collapsed → loading → expanded on IPC success", async () => {
    const content = "line one\nline two\nline three";
    vi.stubGlobal(
      "lvisApi",
      makeApi(() => Promise.resolve({ content, lineCount: 3 })),
    );
    const { container } = render(
      <CompactedToolResult
        toolUseId={TOOL_USE_ID}
        toolName="Read"
        stubContent={STUB}
        sessionId={SESSION_ID}
      />,
    );

    // initial: collapsed
    expect(container.textContent).toContain("▶");

    // click → loading (button is disabled, spinner shown)
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.textContent).toContain("⋯");
    expect(container.textContent).toContain("불러오는 중…");

    // wait for IPC resolve → expanded
    await waitFor(() => {
      expect(container.textContent).toContain("▼");
    });
    expect(container.textContent).toContain("3줄");
    expect(container.textContent).toContain("접기");
    expect(container.textContent).toContain("line one");
    expect(container.textContent).toContain("line two");
    expect(container.textContent).toContain("line three");
  });

  it("pretty-prints JSON verbatim content after expansion", async () => {
    const content = JSON.stringify({
      status: "ok",
      payload: JSON.stringify({ items: [{ title: "보고서", count: 2 }] }),
    });
    vi.stubGlobal(
      "lvisApi",
      makeApi(() => Promise.resolve({ content, lineCount: 1 })),
    );
    const { container } = render(
      <CompactedToolResult
        toolUseId={TOOL_USE_ID}
        toolName="Read"
        stubContent={STUB}
        sessionId={SESSION_ID}
      />,
    );

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);

    await waitFor(() => {
      const codeText = Array.from(container.querySelectorAll(".tre-code"))
        .map((node) => node.textContent ?? "")
        .join("\n");
      expect(codeText).toContain('"payload": {');
      expect(codeText).toContain('"title": "보고서"');
      expect(codeText).not.toContain('\\\"items\\\"');
    });
  });

  it("shows line numbers in expanded body", async () => {
    const content = "alpha\nbeta\ngamma";
    vi.stubGlobal(
      "lvisApi",
      makeApi(() => Promise.resolve({ content, lineCount: 3 })),
    );
    const { container } = render(
      <CompactedToolResult
        toolUseId={TOOL_USE_ID}
        toolName="Read"
        stubContent={STUB}
        sessionId={SESSION_ID}
      />,
    );
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(container.textContent).toContain("▼"));

    const lnSpans = container.querySelectorAll(".tre-ln");
    expect(lnSpans.length).toBe(3);
    expect(lnSpans[0]?.textContent?.trim()).toBe("1");
    expect(lnSpans[1]?.textContent?.trim()).toBe("2");
    expect(lnSpans[2]?.textContent?.trim()).toBe("3");
  });

  it("transitions collapsed → loading → missing on IPC returning null", async () => {
    vi.stubGlobal(
      "lvisApi",
      makeApi(() => Promise.resolve(null)),
    );
    const { container } = render(
      <CompactedToolResult
        toolUseId={TOOL_USE_ID}
        toolName="Read"
        stubContent={STUB}
        sessionId={SESSION_ID}
      />,
    );

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    await waitFor(() => {
      expect(container.textContent).toContain("원본 소실");
    });
    expect(container.textContent).toContain("▸");
    expect(container.textContent).toContain("ⓘ");
  });

  it("transitions collapsed → loading → missing on IPC throw (Major #1 fix)", async () => {
    vi.stubGlobal(
      "lvisApi",
      makeApi(() => Promise.reject(new Error("IPC channel closed"))),
    );
    const { container } = render(
      <CompactedToolResult
        toolUseId={TOOL_USE_ID}
        toolName="Read"
        stubContent={STUB}
        sessionId={SESSION_ID}
      />,
    );

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    await waitFor(() => {
      expect(container.textContent).toContain("원본 소실");
    });
    // must not remain in loading state (no "불러오는 중…")
    expect(container.textContent).not.toContain("불러오는 중…");
    expect(container.textContent).toContain("▸");
  });

  it("clicking 접기 in expanded state collapses back", async () => {
    const content = "single line";
    vi.stubGlobal(
      "lvisApi",
      makeApi(() => Promise.resolve({ content, lineCount: 1 })),
    );
    const { container } = render(
      <CompactedToolResult
        toolUseId={TOOL_USE_ID}
        toolName="Read"
        stubContent={STUB}
        sessionId={SESSION_ID}
      />,
    );

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(container.textContent).toContain("▼"));

    // click 접기 button
    const collapseBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("접기"),
    );
    expect(collapseBtn).toBeTruthy();
    fireEvent.click(collapseBtn!);

    expect(container.textContent).toContain("▶");
    expect(container.textContent).toContain("[펼치기]");
  });

  it("expanded body uses div not pre (HTML content model — Minor fix)", async () => {
    const content = "a\nb";
    vi.stubGlobal(
      "lvisApi",
      makeApi(() => Promise.resolve({ content, lineCount: 2 })),
    );
    const { container } = render(
      <CompactedToolResult
        toolUseId={TOOL_USE_ID}
        toolName="Read"
        stubContent={STUB}
        sessionId={SESSION_ID}
      />,
    );

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(container.textContent).toContain("▼"));

    // there must be no <pre> tag in the expanded body
    expect(container.querySelector("pre")).toBeNull();
    // the line-numbered container should be a div
    const body = container.querySelector(".tre-body > div");
    expect(body).not.toBeNull();
  });
});
