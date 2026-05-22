/**
 * Issue #749 — FileEditDiff component tests.
 *
 * Covers:
 *   1. Non-truncated result renders plain summary (no expand button)
 *   2. Truncated+hasSidecar result shows "전체 diff 보기" button
 *   3. Click → loading state (button disabled, spinner text)
 *   4. IPC success → expanded diff hunks rendered
 *   5. IPC returns null → error state shown
 *   6. IPC throws → error state shown
 *   7. Retry button resets to idle state
 *   8. 접기 button collapses expanded state back to idle
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { WriteFileSidecarDiff as FileEditDiff } from "../components/FileEditDiff.js";
import { makeMockLvisApi } from "../../../../test/renderer/mock-lvis-api.js";

const SESSION_ID = "session-test-1";
const TOOL_USE_ID = "tu-test-1";

const TRUNCATED_RESULT = JSON.stringify({
  path: "/tmp/test.ts",
  bytes: 6000,
  truncated: true,
  hasSidecar: true,
});

const NORMAL_RESULT = JSON.stringify({
  path: "/tmp/small.ts",
  bytes: 100,
});

function fileEditDiffApi(impl: () => Promise<{ before: string; after: string } | null>) {
  const { api } = makeMockLvisApi();
  api.chatGetWriteDiff = vi.fn(impl);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FileEditDiff", () => {
  it("renders plain summary for non-truncated result (no expand button)", () => {
    vi.stubGlobal("lvisApi", fileEditDiffApi(() => Promise.resolve(null)));
    const { container } = render(
      <FileEditDiff
        resultJson={NORMAL_RESULT}
        sessionId={SESSION_ID}
        toolUseId={TOOL_USE_ID}
        filePath="/tmp/small.ts"
      />,
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("/tmp/small.ts");
  });

  it("shows 전체 diff 보기 button for truncated+hasSidecar result", () => {
    vi.stubGlobal("lvisApi", fileEditDiffApi(() => Promise.resolve(null)));
    const { container } = render(
      <FileEditDiff
        resultJson={TRUNCATED_RESULT}
        sessionId={SESSION_ID}
        toolUseId={TOOL_USE_ID}
        filePath="/tmp/test.ts"
      />,
    );
    const btn = container.querySelector("button");
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain("전체 diff 보기");
    expect(container.textContent).toContain("미리보기 제한");
  });

  it("transitions idle → loading on click", () => {
    vi.stubGlobal(
      "lvisApi",
      fileEditDiffApi(() => new Promise(() => {})), // never resolves
    );
    const { container } = render(
      <FileEditDiff resultJson={TRUNCATED_RESULT} sessionId={SESSION_ID} toolUseId={TOOL_USE_ID} />,
    );

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    const btn = container.querySelector("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("불러오는 중…");
  });

  it("transitions idle → loading → expanded on IPC success", async () => {
    const before = "line one\nline two";
    const after = "line one\nline three";
    vi.stubGlobal(
      "lvisApi",
      fileEditDiffApi(() => Promise.resolve({ before, after })),
    );
    const { container } = render(
      <FileEditDiff resultJson={TRUNCATED_RESULT} sessionId={SESSION_ID} toolUseId={TOOL_USE_ID} />,
    );

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);

    await waitFor(() => {
      expect(container.textContent).toContain("접기");
    });
    // Diff hunks should be visible
    expect(container.textContent).toContain("line one");
    expect(container.textContent).toContain("line two");
    expect(container.textContent).toContain("line three");
  });

  it("transitions idle → loading → error on IPC returning null", async () => {
    vi.stubGlobal(
      "lvisApi",
      fileEditDiffApi(() => Promise.resolve(null)),
    );
    const { container } = render(
      <FileEditDiff resultJson={TRUNCATED_RESULT} sessionId={SESSION_ID} toolUseId={TOOL_USE_ID} />,
    );

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);

    await waitFor(() => {
      expect(container.textContent).toContain("소실");
    });
    expect(container.textContent).toContain("재시도");
  });

  it("transitions idle → loading → error on IPC throw", async () => {
    vi.stubGlobal(
      "lvisApi",
      fileEditDiffApi(() => Promise.reject(new Error("IPC closed"))),
    );
    const { container } = render(
      <FileEditDiff resultJson={TRUNCATED_RESULT} sessionId={SESSION_ID} toolUseId={TOOL_USE_ID} />,
    );

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);

    await waitFor(() => {
      expect(container.textContent).toContain("재시도");
    });
    expect(container.textContent).not.toContain("불러오는 중…");
  });

  it("retry button resets error state back to idle", async () => {
    vi.stubGlobal(
      "lvisApi",
      fileEditDiffApi(() => Promise.resolve(null)),
    );
    const { container } = render(
      <FileEditDiff resultJson={TRUNCATED_RESULT} sessionId={SESSION_ID} toolUseId={TOOL_USE_ID} />,
    );

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(container.textContent).toContain("재시도"));

    const retryBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("재시도"),
    );
    expect(retryBtn).toBeTruthy();
    fireEvent.click(retryBtn!);

    // Should be back in idle — expand button visible again
    const expandBtn = container.querySelector("button");
    expect(expandBtn?.textContent).toContain("전체 diff 보기");
  });

  it("접기 button collapses expanded state back to idle", async () => {
    const before = "alpha\nbeta";
    const after = "alpha\ngamma";
    vi.stubGlobal(
      "lvisApi",
      fileEditDiffApi(() => Promise.resolve({ before, after })),
    );
    const { container } = render(
      <FileEditDiff resultJson={TRUNCATED_RESULT} sessionId={SESSION_ID} toolUseId={TOOL_USE_ID} />,
    );

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(container.textContent).toContain("접기"));

    const collapseBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("접기"),
    );
    expect(collapseBtn).toBeTruthy();
    fireEvent.click(collapseBtn!);

    // Back to idle — expand button visible again
    const expandBtn = container.querySelector("button");
    expect(expandBtn?.textContent).toContain("전체 diff 보기");
  });

  it("renders + and - markers in diff hunks for added/removed lines", async () => {
    const before = "unchanged\nremoved line\nstays";
    const after = "unchanged\nadded line\nstays";
    vi.stubGlobal(
      "lvisApi",
      fileEditDiffApi(() => Promise.resolve({ before, after })),
    );
    const { container } = render(
      <FileEditDiff resultJson={TRUNCATED_RESULT} sessionId={SESSION_ID} toolUseId={TOOL_USE_ID} />,
    );

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(container.textContent).toContain("접기"));

    expect(container.textContent).toContain("+");
    expect(container.textContent).toContain("-");
    expect(container.textContent).toContain("removed line");
    expect(container.textContent).toContain("added line");
  });

  it("unmount mid-IPC does not trigger setState or React warning", async () => {
    // isMountedRef guard: after unmount the promise resolution must be a no-op.
    let resolve!: (v: { before: string; after: string }) => void;
    const pending = new Promise<{ before: string; after: string }>((res) => {
      resolve = res;
    });
    vi.stubGlobal("lvisApi", fileEditDiffApi(() => pending));

    const warnSpy = vi.spyOn(console, "error");
    const { container, unmount } = render(
      <FileEditDiff resultJson={TRUNCATED_RESULT} sessionId={SESSION_ID} toolUseId={TOOL_USE_ID} />,
    );

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    // Unmount before the IPC resolves.
    unmount();
    // Now resolve — isMountedRef guard must swallow this.
    await act(async () => {
      resolve({ before: "a", after: "b" });
      // Flush micro-task queue.
      await Promise.resolve();
    });

    // React must not have emitted an "unmounted component setState" warning.
    const errCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    const stateWarning = errCalls.some((m) => m.includes("unmounted") || m.includes("memory leak"));
    expect(stateWarning).toBe(false);
    warnSpy.mockRestore();
  });
});
