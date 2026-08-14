/**
 * ApprovalDock unit tests.
 *
 * The route-independent dock floats at the route canvas bottom and never
 * portals or applies modal semantics. Security and durable-decision assertions
 * stay colocated.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, fireEvent, waitFor } from "@testing-library/react";
import { ApprovalDock } from "../components/permissions/ApprovalDock.js";
import type { ApprovalRequest, PermissionEvaluationContext } from "../types.js";

function makeEvaluationContext(overrides: Partial<PermissionEvaluationContext> = {}): PermissionEvaluationContext {
  return {
    version: "permission-evaluation-context/v1",
    reviewerFrameworkVersion: "permission-reviewer-framework/v1",
    policyMode: "auto",
    headless: false,
    source: "builtin",
    category: "shell",
    trustOrigin: "user-keyboard",
    executionCwd: "C:\\workspace\\lvis-app",
    allowedDirectories: ["C:\\workspace\\lvis-app", "C:\\tmp"],
    pathFields: ["path"],
    targetFilePaths: ["C:\\workspace\\lvis-app\\README.md"],
    sensitivePathsAdjacent: [],
    ...overrides,
  };
}

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-1",
    category: "tool",
    toolName: "read_file",
    toolCategory: "read",
    args: { path: "/tmp/test.txt" },
    reason: "파일 읽기 요청",
    createdAt: Date.now(),
    requireExplicit: false,
    ...overrides,
  };
}

describe("ApprovalDock", () => {
  // ToolApprovalContent persists an exact allow before resolving the gate.
  // Without this mock the card correctly stays open with a save error.
  // vi.stubGlobal is used so the outer afterEach's vi.unstubAllGlobals() handles cleanup.
  beforeEach(() => {
    vi.stubGlobal("lvis", {
      userApproval: {
        record: vi.fn().mockResolvedValue({ ok: true }),
        revokeByKey: vi.fn().mockResolvedValue({ ok: true }),
        list: vi.fn().mockResolvedValue([]),
      },
    });
  });

  it("renders without crashing with empty queue", () => {
    const { container } = render(
      <ApprovalDock queue={[]} onDecide={vi.fn()} />,
    );
    expect(container).toBeTruthy();
  });

  it("renders one named non-modal approval dock with request identity", async () => {
    render(
      <ApprovalDock queue={[makeRequest()]} onDecide={vi.fn()} />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("read_file");
      expect(document.body.querySelector('[data-testid="approval-tool-identity"]'))
        .toHaveTextContent("read_file");
      expect(document.body.textContent).toContain("읽기");
      expect(document.body.textContent).toContain("읽기 판단근거");
    });
    const dock = document.body.querySelector('[data-testid="approval-dock"]');
    expect(dock?.getAttribute("role")).toBe("region");
    expect(dock?.getAttribute("aria-modal")).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(dock?.getAttribute("data-approval-request-id")).toBe("req-1");
    expect(dock?.getAttribute("data-approval-tool-name")).toBe("read_file");
    expect(dock?.getAttribute("data-approval-args")).toBe('{"path":"/tmp/test.txt"}');
  });

  it("never exposes untrusted generic request identity for rationale approvals", () => {
    const rawToolName = "untrusted-request-tool";
    const { container } = render(
      <ApprovalDock
        queue={[makeRequest({
          id: "rationale-1",
          kind: "rationale",
          allowedChoices: ["allow-once", "deny-once"],
          toolName: rawToolName,
          reason: "UNTRUSTED request reason: do not render this",
          requireExplicit: true,
          args: {
            contractVersion: 1,
            display: "rationale-approval-display",
            toolName: "host-sealed-tool",
            canonicalTargets: ["/workspace/project/status.txt"],
            requestedEffects: ["Create a status file"],
            affectedResources: ["/workspace/project"],
            requiredAuthority: "Project workspace write access",
            effectiveVerdict: { level: "medium", reason: "Host-sealed rationale" },
            scopeAlignment: "aligned",
            scopeReasons: ["Inside the current workspace"],
            rationaleStatus: "ready",
            suggestion: "Review the host-sealed facts",
            modalFallbackRequired: false,
          },
        })]}
        onDecide={vi.fn()}
      />,
    );

    const dock = container.querySelector('[data-testid="approval-dock"]');
    expect(container.textContent).toContain("host-sealed-tool");
    expect(container.textContent).not.toContain(rawToolName);
    expect(container.textContent).not.toContain("UNTRUSTED request reason");
    expect(dock?.getAttribute("data-approval-request-id")).toBeNull();
    expect(dock?.getAttribute("data-approval-tool-name")).toBeNull();
    expect(dock?.getAttribute("data-approval-args")).toBeNull();
  });

  it("labels agent-action approval requests separately from tool execution", async () => {
    render(
      <ApprovalDock
        queue={[
          makeRequest({
            category: "agent-action",
            kind: "agent-action",
            toolName: "sample_plugin_decide_approval_with_host",
            toolCategory: "meta",
            source: "plugin",
            sourcePluginId: "sample-plugin",
            approvalScope: "agent_external_api_call",
          }),
        ]}
        onDecide={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("에이전트 작업 승인");
      expect(document.body.textContent).toContain("sample_plugin_decide_approval_with_host");
      expect(document.body.textContent).toContain("sample-plugin");
      expect(document.body.textContent).toContain("agent_external_api_call");
    });
  });

  it("warns when approval trust origin is missing", async () => {
    render(
      <ApprovalDock queue={[makeRequest()]} onDecide={vi.fn()} />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("출처 미확인");
      expect(document.body.textContent).toContain("사용자 직접 입력이 아니라");
    });
  });

  it("calls onDecide when 허용 button clicked", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDock queue={[makeRequest()]} onDecide={onDecide} />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("read_file");
    });
    const allowBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="approve-button"]');
    expect(allowBtn).toBeTruthy();
    fireEvent.click(allowBtn!);
    expect(onDecide).toHaveBeenCalled();
    expect(onDecide.mock.calls[0]?.[0]).toMatch(/allow/);
  });

  it("does not convert Enter on a focused deny button into allow-once", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDock queue={[makeRequest({
        toolName: "bash",
        toolCategory: "shell",
        reviewerVerdict: { level: "low", reason: "test fixture — exercise A/D shortcut path, not R-4 HIGH NL gate" },
      })]} onDecide={onDecide} />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("bash");
    });

    const denyBtn = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "거절",
    );
    expect(denyBtn).toBeTruthy();
    denyBtn!.focus();
    fireEvent.keyDown(denyBtn!, { key: "Enter", code: "Enter" });
    expect(onDecide).not.toHaveBeenCalledWith("allow-once", undefined);

    fireEvent.click(denyBtn!);
    expect(onDecide.mock.calls[0]?.[0]).toBe("deny-once");
  });

  it("keeps advertised A/D shortcuts active when an action button has focus", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDock queue={[makeRequest({
        toolName: "bash",
        toolCategory: "shell",
        reviewerVerdict: { level: "low", reason: "test fixture — exercise A/D shortcut path, not R-4 HIGH NL gate" },
      })]} onDecide={onDecide} />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("bash");
    });

    const denyBtn = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "거절",
    );
    expect(denyBtn).toBeTruthy();
    denyBtn!.focus();

    // The advertised A shortcut is the narrow, non-durable decision.
    fireEvent.keyDown(denyBtn!, { key: "a", code: "KeyA" });
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);

    onDecide.mockClear();
    fireEvent.keyDown(denyBtn!, { key: "d", code: "KeyD" });
    expect(onDecide).toHaveBeenCalledWith("deny-once", undefined);
  });

  it("moves across the three decision buttons with Left and Right arrows", async () => {
    render(
      <ApprovalDock queue={[makeRequest()]} onDecide={vi.fn()} />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("read_file"));

    const deny = document.body.querySelector<HTMLButtonElement>('[data-testid="deny-button"]')!;
    const always = document.body.querySelector<HTMLButtonElement>('[data-testid="allow-always-button"]')!;
    const once = document.body.querySelector<HTMLButtonElement>('[data-testid="approve-button"]')!;

    once.focus();
    fireEvent.keyDown(once, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(always);
    fireEvent.keyDown(always, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(deny);
    fireEvent.keyDown(deny, { key: "ArrowRight" });
    expect(document.activeElement).toBe(always);
    fireEvent.keyDown(always, { key: "ArrowRight" });
    expect(document.activeElement).toBe(once);
  });

  it("skips a disabled Always allow decision during arrow navigation", async () => {
    render(
      <ApprovalDock
        queue={[makeRequest({
          toolName: "bash",
          toolCategory: "shell",
          reviewerVerdict: { level: "high", reason: "shell command" },
          allowedChoices: ["allow-once", "deny-once"],
        })]}
        onDecide={vi.fn()}
      />,
    );

    const deny = document.body.querySelector<HTMLButtonElement>('[data-testid="deny-button"]')!;
    const always = document.body.querySelector<HTMLButtonElement>('[data-testid="allow-always-button"]')!;
    const once = document.body.querySelector<HTMLButtonElement>('[data-testid="approve-button"]')!;
    expect(always).toBeDisabled();

    once.focus();
    fireEvent.keyDown(once, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(deny);
    fireEvent.keyDown(deny, { key: "ArrowRight" });
    expect(document.activeElement).toBe(once);
  });

  it("keeps route controls interactive and scopes decision shortcuts to the dock", async () => {
    const onDecide = vi.fn();
    const { container } = render(
      <main data-testid="background-route">
        <button type="button" data-testid="background-action">Background action</button>
        <ApprovalDock queue={[makeRequest()]} onDecide={onDecide} />
      </main>,
    );

    const background = container.querySelector<HTMLButtonElement>('[data-testid="background-action"]')!;
    const dock = container.querySelector<HTMLElement>('[data-testid="approval-dock"]')!;
    const panel = container.querySelector<HTMLElement>('[data-testid="tool-approval-panel"]')!;
    expect(dock).toBeTruthy();
    expect(container.querySelector('[data-testid="background-route"]')?.hasAttribute("inert")).toBe(false);
    expect(container.querySelector('[data-testid="background-route"]')?.getAttribute("aria-hidden")).toBeNull();
    expect(document.body.getAttribute("data-scroll-locked")).toBeNull();

    background.focus();
    fireEvent.keyDown(background, { key: "a", code: "KeyA" });
    fireEvent.keyDown(background, { key: "d", code: "KeyD" });
    fireEvent.keyDown(background, { key: "Escape", code: "Escape" });
    expect(onDecide).not.toHaveBeenCalled();

    panel.focus();
    fireEvent.keyDown(panel, { key: "d", code: "KeyD" });
    expect(onDecide).toHaveBeenCalledWith("deny-once", undefined);
  });

  it("renders HIGH approval without any typeable approval control", async () => {
    const onDecide = vi.fn();
    const { container } = render(
      <ApprovalDock
        queue={[makeRequest({
          toolName: "bash",
          toolCategory: "shell",
          requireExplicit: true,
          reviewerVerdict: { level: "high", reason: "destructive command" },
        })]}
        onDecide={onDecide}
      />,
    );

    expect(container.querySelector('input, textarea, [contenteditable="true"], [role="textbox"]'))
      .toBeNull();
    expect(container.querySelector('[data-testid="high-risk-audit-reason"]'))
      .toHaveTextContent("destructive command");
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("focuses an enabled decision on first mount and FIFO advance, then restores route focus", async () => {
    const onDecide = vi.fn();
    const first = makeRequest({ id: "req-focus-1" });
    const second = makeRequest({ id: "req-focus-2", toolName: "write_file" });
    const { container, rerender } = render(
      <main>
        <button type="button" data-testid="return-target">Return target</button>
        <ApprovalDock queue={[]} onDecide={onDecide} />
      </main>,
    );
    const returnTarget = container.querySelector<HTMLButtonElement>('[data-testid="return-target"]')!;
    returnTarget.focus();

    rerender(
      <main>
        <button type="button" data-testid="return-target">Return target</button>
        <ApprovalDock queue={[first, second]} onDecide={onDecide} />
      </main>,
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(
        container.querySelector('[data-testid="deny-button"]'),
      );
    });

    container.querySelector<HTMLButtonElement>('[data-testid="deny-button"]')!.focus();
    rerender(
      <main>
        <button type="button" data-testid="return-target">Return target</button>
        <ApprovalDock queue={[second]} onDecide={onDecide} />
      </main>,
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(container.querySelector('[data-testid="deny-button"]'));
    });
    const secondDecision = container.querySelector<HTMLButtonElement>('[data-testid="deny-button"]')!;
    fireEvent.keyDown(secondDecision, { key: "d", code: "KeyD" });
    expect(onDecide).toHaveBeenCalledWith("deny-once", undefined);

    rerender(
      <main>
        <button type="button" data-testid="return-target">Return target</button>
        <ApprovalDock queue={[]} onDecide={onDecide} />
      </main>,
    );
    await waitFor(() => expect(document.activeElement).toBe(returnTarget));
  });

  it("obscures only the covered composer and restores it with focus after approval", async () => {
    const request = makeRequest({ id: "req-covered-composer" });
    const { container, rerender } = render(
      <main data-testid="route-canvas">
        <button type="button" data-testid="background-action">Background action</button>
        <div data-composer-placement="bottom">
          <textarea data-testid="composer-textarea" />
        </div>
        <ApprovalDock queue={[]} onDecide={vi.fn()} />
      </main>,
    );
    const composer = container.querySelector<HTMLElement>('[data-composer-placement]')!;
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="composer-textarea"]')!;
    const background = container.querySelector<HTMLElement>('[data-testid="background-action"]')!;
    textarea.focus();

    rerender(
      <main data-testid="route-canvas">
        <button type="button" data-testid="background-action">Background action</button>
        <div data-composer-placement="bottom">
          <textarea data-testid="composer-textarea" />
        </div>
        <ApprovalDock queue={[request]} onDecide={vi.fn()} />
      </main>,
    );
    await waitFor(() => {
      expect(composer).toHaveAttribute("inert");
      expect(composer).toHaveAttribute("aria-hidden", "true");
      expect(document.activeElement).toBe(container.querySelector('[data-testid="deny-button"]'));
    });
    expect(background).not.toHaveAttribute("inert");
    expect(background).not.toHaveAttribute("aria-hidden");

    rerender(
      <main data-testid="route-canvas">
        <button type="button" data-testid="background-action">Background action</button>
        <div data-composer-placement="bottom">
          <textarea data-testid="composer-textarea" />
        </div>
        <ApprovalDock queue={[]} onDecide={vi.fn()} />
      </main>,
    );
    await waitFor(() => {
      expect(composer).not.toHaveAttribute("inert");
      expect(composer).not.toHaveAttribute("aria-hidden");
      expect(document.activeElement).toBe(textarea);
    });
  });

  it("hands focus to a question that arrived beneath the approval overlay", async () => {
    const request = makeRequest({ id: "req-question-focus-handoff" });
    const { container, rerender } = render(
      <main data-testid="route-canvas">
        <div data-composer-placement="bottom">
          <textarea data-testid="composer-textarea" />
        </div>
        <ApprovalDock queue={[]} onDecide={vi.fn()} />
      </main>,
    );
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="composer-textarea"]')!;
    textarea.focus();

    rerender(
      <main data-testid="route-canvas">
        <div data-composer-placement="bottom">
          <textarea data-testid="composer-textarea" />
          <div data-testid="question-overlay">
            <button type="button" role="option" tabIndex={0} data-testid="question-choice">
              Today
            </button>
          </div>
        </div>
        <ApprovalDock queue={[request]} onDecide={vi.fn()} />
      </main>,
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(container.querySelector('[data-testid="deny-button"]'));
    });

    rerender(
      <main data-testid="route-canvas">
        <div data-composer-placement="bottom">
          <textarea data-testid="composer-textarea" />
          <div data-testid="question-overlay">
            <button type="button" role="option" tabIndex={0} data-testid="question-choice">
              Today
            </button>
          </div>
        </div>
        <ApprovalDock queue={[]} onDecide={vi.fn()} />
      </main>,
    );
    // Real IPC resolution can cause a second empty-queue render before the
    // browser's next frame; that rerender must not cancel the focus handoff.
    rerender(
      <main data-testid="route-canvas">
        <div data-composer-placement="bottom">
          <textarea data-testid="composer-textarea" />
          <div data-testid="question-overlay">
            <button type="button" role="option" tabIndex={0} data-testid="question-choice">
              Today
            </button>
          </div>
        </div>
        <ApprovalDock queue={[]} onDecide={vi.fn()} />
      </main>,
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(container.querySelector('[data-testid="question-choice"]'));
      expect(document.activeElement).not.toBe(textarea);
    });
  });

  it("keeps Reject as the sole tab stop when approval is invalid", async () => {
    render(
      <ApprovalDock
        queue={[makeRequest({
          kind: "rationale",
          toolCategory: "shell",
          args: { malformed: true },
        })]}
        onDecide={vi.fn()}
      />,
    );

    const deny = document.body.querySelector<HTMLButtonElement>('[data-testid="deny-button"]')!;
    await waitFor(() => expect(deny.tabIndex).toBe(0));
    expect(deny).toBeEnabled();
    // Reject is the sole tab stop because it is the sole DECISION: the allow
    // options are not rendered at all for an unverifiable seal.
    expect(document.body.querySelector('[data-testid="allow-always-button"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="approve-button"]')).toBeNull();
    expect(document.activeElement).toBe(deny);
  });

  it("does not show tool name when queue is empty", () => {
    render(
      <ApprovalDock queue={[]} onDecide={vi.fn()} />,
    );
    expect(document.body.textContent).not.toContain("read_file");
  });

  it("shows first item when multiple items in queue", async () => {
    const queue = [
      makeRequest({ id: "req-1" }),
      makeRequest({ id: "req-2", toolName: "write_file", toolCategory: "write" }),
    ];
    render(
      <ApprovalDock queue={queue} onDecide={vi.fn()} />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("read_file");
    });
    expect(document.body.querySelector('[data-testid="approval-inline-queue-depth"]')?.textContent)
      .toContain("1 / 2");
    expect(document.body.textContent).toContain("대기 중 1개");
    expect(document.body.textContent).not.toContain("모두 허용");
  });

  it("renders the sandbox capability row with ⚠ when kind=none (#691 round-1 user request)", async () => {
    render(
      <ApprovalDock
        queue={[makeRequest({
          toolName: "bash",
          toolCategory: "shell",
          sandboxCapability: {
            kind: "none",
            confidence: "verified",
            platform: "darwin",
            reason: "no OS sandbox configured for the host process",
          },
        })]}
        onDecide={vi.fn()}
      />,
    );
    await waitFor(() => {
      const row = document.body.querySelector('[data-testid="tool-approval-sandbox"]');
      expect(row).toBeTruthy();
      // Round-5 UX MAJOR — plain Korean copy; raw English `reason`
      // field no longer leaks into UI. "OS 격리 없음" is the canonical
      // weak-sandbox message.
      expect(row!.textContent).toContain("⚠");
      expect(row!.textContent).toContain("OS 격리 없음");
    });
  });

  it("renders the sandbox capability row WITHOUT ⚠ when kind=asrt + confidence=verified", async () => {
    render(
      <ApprovalDock
        queue={[makeRequest({
          toolName: "bash",
          toolCategory: "shell",
          sandboxCapability: {
            kind: "asrt",
            confidence: "verified",
            platform: "linux",
            reason: "ASRT (bwrap) active — fs+process+network contained",
          },
        })]}
        onDecide={vi.fn()}
      />,
    );
    await waitFor(() => {
      const row = document.body.querySelector('[data-testid="tool-approval-sandbox"]');
      expect(row).toBeTruthy();
      // Round-5 UX MAJOR — strong sandbox renders "OS 격리 활성".
      expect(row!.textContent).toContain("OS 격리 활성");
      expect(row!.textContent).toContain("asrt");
      expect(row!.textContent).not.toContain("⚠");
    });
  });

  it("renders ⚠ weak when kind=partial (HIGH-1 SOT consumer regression guard)", async () => {
    render(
      <ApprovalDock
        queue={[makeRequest({
          toolName: "bash",
          toolCategory: "shell",
          sandboxCapability: {
            kind: "partial",
            confidence: "verified",
            platform: "darwin",
            reason: "partial OS isolation profile",
          },
        })]}
        onDecide={vi.fn()}
      />,
    );
    await waitFor(() => {
      const row = document.body.querySelector('[data-testid="tool-approval-sandbox"]');
      expect(row).toBeTruthy();
      // MAJOR-2.1 fix: partial now shows its own distinct Korean label
      // (partial isolation IS present — "OS 격리 없음" was factually wrong)
      expect(row!.textContent).toContain("⚠");
      expect(row!.textContent).toContain("OS 격리 부분적");
    });
  });

  it("renders ℹ fs-only label when kind=fs-only + confidence=verified", async () => {
    render(
      <ApprovalDock
        queue={[makeRequest({
          toolName: "bash",
          toolCategory: "shell",
          sandboxCapability: {
            kind: "fs-only",
            confidence: "verified",
            platform: "linux",
            reason: "landlock LSM active",
          },
        })]}
        onDecide={vi.fn()}
      />,
    );
    await waitFor(() => {
      const row = document.body.querySelector('[data-testid="tool-approval-sandbox"]');
      expect(row).toBeTruthy();
      // MAJOR-2.1 fix: fs-only now shows Korean label instead of raw "OS 격리 활성 (fs-only)"
      expect(row!.textContent).not.toContain("⚠");
      expect(row!.textContent).toContain("파일시스템만 격리");
      expect(row!.textContent).toContain("landlock");
    });
  });

  it("omits the sandbox row entirely when sandboxCapability is undefined", async () => {
    render(
      <ApprovalDock
        queue={[makeRequest({ toolName: "read_file", toolCategory: "read" })]}
        onDecide={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="tool-approval-sandbox"]')).toBeNull();
    });
  });

  it("surfaces captured permission evaluation context instead of reconstructing sandbox details from args", async () => {
    render(
      <ApprovalDock
        queue={[makeRequest({
          toolName: "powershell",
          toolCategory: "shell",
          args: { command: "Get-ChildItem", cwd: "stale-from-args" },
          reviewerVerdict: { level: "medium", reason: "shell unclassified" },
          evaluationContext: makeEvaluationContext({
            executionCwd: "C:\\Users\\ikcha\\workspace\\lvis-project\\lvis-app",
            allowedDirectories: ["C:\\Users\\ikcha\\workspace\\lvis-project\\lvis-app"],
            targetFilePaths: [],
          }),
        })]}
        onDecide={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("검증 환경 / 샌드박스 평가");
      expect(document.body.textContent).toContain("permission-evaluation-context/v1");
      expect(document.body.textContent).toContain("permission-reviewer-framework/v1");
      expect(document.body.textContent).toContain("C:\\Users\\ikcha\\workspace\\lvis-project\\lvis-app");
    });
  });

  it("renders no modal for out-of-allowed-dir — the docked card serves it", async () => {
    // The modal OutOfAllowedDirCard was replaced by DockedApprovalCard, which
    // lives in the chat region. Rendering a modal here as well would put two
    // surfaces on one decision.
    const onDecide = vi.fn();
    const onOpenPermanentDeny = vi.fn();
    const { container } = render(
      <ApprovalDock
        queue={[
          makeRequest({
            kind: "out-of-allowed-dir",
            toolName: "read_file",
            reason: "out-of-allowed-dir",
            requireExplicit: true,
            outOfAllowedDir: {
              candidatePath: "/Users/ken/Documents/project/notes.md",
              suggestedParent: "/Users/ken/Documents/project",
              currentAllowed: ["/Users/ken/workspace/GIT/github/lvis-project"],
              adjacencyWarnings: [],
            },
          }),
        ]}
        onDecide={onDecide}
        onOpenPermanentDeny={onOpenPermanentDeny}
      />,
    );

    expect(container.querySelector('[data-testid="approval-dock"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="docked-approval-panel"]')).toBeTruthy();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain("/Users/ken/Documents/project/notes.md");
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-testid="open-permanent-deny-settings"]')!);
    expect(onOpenPermanentDeny).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "out-of-allowed-dir", toolName: "read_file" }),
      "low",
    );
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("uses the host fallback verdict for a shell out-of-dir exact deny", async () => {
    const onOpenPermanentDeny = vi.fn();
    const { container } = render(
      <ApprovalDock
        queue={[makeRequest({
          kind: "out-of-allowed-dir",
          toolName: "bash",
          toolCategory: "shell",
          reason: "out-of-allowed-dir",
          requireExplicit: true,
          outOfAllowedDir: {
            candidatePath: "/Users/ken/Documents/project/output.txt",
            suggestedParent: "/Users/ken/Documents/project",
            currentAllowed: ["/Users/ken/workspace/GIT/github/lvis-project"],
            adjacencyWarnings: [],
          },
        })]}
        onDecide={vi.fn()}
        onOpenPermanentDeny={onOpenPermanentDeny}
      />,
    );

    fireEvent.click(
      container.querySelector<HTMLButtonElement>('[data-testid="open-permanent-deny-settings"]')!,
    );
    expect(onOpenPermanentDeny).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "bash", toolCategory: "shell" }),
      "high",
    );
  });

  it("shows a read-only HIGH reason from the originating request and enables explicit approval", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDock
        queue={[makeRequest({
          toolName: "bash",
          toolCategory: "shell",
          reviewerVerdict: { level: "high", reason: "shell command" },
          trustOrigin: "llm-tool-arg",
          approvalPurpose: {
            text: "사용자 요청에 따라 프로젝트 빌드 결과를 확인합니다.",
            source: "conversation",
            confidence: "sufficient",
          },
        })]}
        onDecide={onDecide}
      />,
    );

    expect(document.body.querySelector('[data-testid="nl-justification-input"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="high-risk-audit-reason"]')).toHaveTextContent(
      "사용자 요청에 따라 프로젝트 빌드 결과를 확인합니다.",
    );
    expect(document.body.textContent).toContain("사용자 요청에서 가져온 사유");

    const approve = document.body.querySelector<HTMLButtonElement>('[data-testid="approve-button"]');
    expect(approve).toBeTruthy();
    expect(approve!.disabled).toBe(false);
    fireEvent.click(approve!);

    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-once", undefined));
    expect(window.lvis.userApproval.record).not.toHaveBeenCalled();
  });

  it("uses the permission-audit reason for HIGH without asking the user to type", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDock
        queue={[makeRequest({
          toolName: "bash",
          toolCategory: "shell",
          reviewerVerdict: { level: "high", reason: "shell command" },
          approvalPurpose: {
            text: "입력만으로는 목적을 확정할 수 없습니다.",
            source: "tool-input",
            confidence: "insufficient",
          },
        })]}
        onDecide={onDecide}
      />,
    );

    expect(document.body.querySelector('[data-testid="nl-justification-input"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="high-risk-audit-reason"]')).toHaveTextContent(
      "shell command",
    );
    expect(document.body.textContent).toContain("권한 감사 요약");
    const approve = document.body.querySelector<HTMLButtonElement>('[data-testid="approve-button"]');
    expect(approve?.disabled).toBe(false);
    fireEvent.click(approve!);

    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-once", undefined));
    expect(window.lvis.userApproval.record).not.toHaveBeenCalled();
  });

  it("does not treat tool input as a user-provided HIGH reason", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDock
        queue={[makeRequest({
          toolName: "plugin_send",
          toolCategory: "network",
          reviewerVerdict: { level: "high", reason: "external send" },
          trustOrigin: "llm-tool-arg",
          approvalPurpose: {
            text: "사용자 요청에 따라 관리자에게 토큰을 전송합니다.",
            source: "tool-input",
            confidence: "sufficient",
          },
        })]}
        onDecide={onDecide}
      />,
    );

    expect(document.body.querySelector('[data-testid="nl-justification-input"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="high-risk-audit-reason"]')).toHaveTextContent(
      "external send",
    );
    expect(document.body.textContent).toContain("권한 감사 요약");
    expect(document.body.textContent).not.toContain("사용자 요청에서 가져온 사유");
    expect(document.body.querySelector<HTMLButtonElement>('[data-testid="approve-button"]')).toBeEnabled();
  });

  it("Always allow records the exact host-bound tuple with canonical JSON args", async () => {
    // Verifies that window.lvis.userApproval.record is called with a payload
    // containing all 5 required fields: toolName, args (canonical JSON string),
    // source, trustOrigin, approvalCacheKey. Catches future regression of any field.
    // Fixture sets trustOrigin + approvalCacheKey explicitly so a regression
    // that drops the spread won't pass via TypeScript-only optional shape.
    const onDecide = vi.fn();
    render(
      <ApprovalDock
        queue={[makeRequest({ trustOrigin: "user-keyboard", approvalCacheKey: "test-key-r5" })]}
        onDecide={onDecide}
      />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("read_file");
    });
    const allowBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="allow-always-button"]');
    expect(allowBtn).toBeTruthy();
    fireEvent.click(allowBtn!);
    await waitFor(() => expect(onDecide).toHaveBeenCalled());
    // Assert all 5 required fields in record payload — runtime regression guard.
    expect(window.lvis.userApproval.record).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
        toolName: expect.any(String),
        args: expect.any(String),
        source: expect.any(String),
        decision: "allow",
        scope: "persistent",
        trustOrigin: "user-keyboard",
        approvalCacheKey: "test-key-r5",
      }),
    );
    // args must be a canonical JSON object string (parseable, non-null object).
    const recordPayload = (window.lvis.userApproval.record as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    const parsedArgs = JSON.parse(recordPayload.args as string) as unknown;
    expect(parsedArgs !== null && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)).toBe(true);
  });

  it("Allow once never writes exact decision memory", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDock queue={[makeRequest()]} onDecide={onDecide} />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("read_file"));
    const approve = document.body.querySelector<HTMLButtonElement>('[data-testid="approve-button"]');
    fireEvent.click(approve!);
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-once", undefined));
    expect(window.lvis.userApproval.record).not.toHaveBeenCalled();
  });

  it("shows compact write summary, collapsed review affordance, and exact-deny Settings link", async () => {
    const onOpenPermanentDeny = vi.fn();
    const onDecide = vi.fn();
    render(
      <ApprovalDock
        queue={[makeRequest({
          toolCategory: "write",
          reason: "user confirmation required (category: write, trust: medium)",
        })]}
        onDecide={onDecide}
        onOpenPermanentDeny={onOpenPermanentDeny}
      />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("read_file"));
    const impact = document.body.querySelector<HTMLElement>('[data-testid="approval-impact-summary"]');
    expect(impact).toBeTruthy();
    expect(impact).not.toHaveTextContent("user confirmation required");
    expect(impact).not.toHaveTextContent("category: write");
    expect(document.body.textContent).toContain("쓰기");
    const details = document.body.querySelector<HTMLDetailsElement>('[data-testid="approval-review-details"]');
    expect(details).toBeTruthy();
    expect(details!.open).toBe(false);
    expect(document.body.textContent).toContain("대상·영향·보호 조치·전체 입력을 펼쳐서 확인");
    fireEvent.click(document.body.querySelector<HTMLButtonElement>('[data-testid="open-permanent-deny-settings"]')!);
    expect(onOpenPermanentDeny).toHaveBeenCalledWith(
      expect.objectContaining({ id: "req-1", toolName: "read_file" }),
      "medium",
    );
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("'항상 허용' records a persistent grant", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDock queue={[makeRequest()]} onDecide={onDecide} />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("read_file"));
    const alwaysBtn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "항상 허용",
    );
    expect(alwaysBtn).toBeTruthy();
    fireEvent.click(alwaysBtn!);
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-always", undefined));
    expect(window.lvis.userApproval.record).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "allow", scope: "persistent" }),
    );
  });

  it("locks every decision path while an exact allow record is in flight", async () => {
    let resolveRecord!: (value: { ok: true }) => void;
    const record = window.lvis.userApproval.record as ReturnType<typeof vi.fn>;
    record.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRecord = resolve;
    }));
    const onDecide = vi.fn();
    const onOpenPermanentDeny = vi.fn();
    render(
      <ApprovalDock
        queue={[makeRequest()]}
        onDecide={onDecide}
        onOpenPermanentDeny={onOpenPermanentDeny}
      />,
    );

    fireEvent.click(document.body.querySelector<HTMLButtonElement>('[data-testid="allow-always-button"]')!);
    await waitFor(() => {
      expect(document.body.querySelector<HTMLButtonElement>('[data-testid="deny-button"]')).toBeDisabled();
      expect(document.body.querySelector<HTMLButtonElement>('[data-testid="open-permanent-deny-settings"]')).toBeDisabled();
    });
    const panel = document.body.querySelector<HTMLElement>('[data-testid="tool-approval-panel"]')!;
    fireEvent.keyDown(panel, { key: "d" });
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onDecide).not.toHaveBeenCalled();
    expect(onOpenPermanentDeny).not.toHaveBeenCalled();

    await act(async () => resolveRecord({ ok: true }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1));
    expect(onDecide).toHaveBeenCalledWith("allow-always", undefined);
  });

  it("locks decisions but keeps the Settings return path available while exact deny is edited", async () => {
    const onDecide = vi.fn();
    const onOpenPermanentDeny = vi.fn();
    render(
      <ApprovalDock
        queue={[makeRequest()]}
        onDecide={onDecide}
        onOpenPermanentDeny={onOpenPermanentDeny}
        interactionLocked
      />,
    );

    expect(document.body.querySelector('[data-testid="approval-decision-locked"]'))
      .toHaveTextContent("설정에서 이 정확한 거절을 저장하거나 취소");
    expect(document.body.querySelector<HTMLButtonElement>('[data-testid="deny-button"]')).toBeDisabled();
    expect(document.body.querySelector<HTMLButtonElement>('[data-testid="allow-always-button"]')).toBeDisabled();
    expect(document.body.querySelector<HTMLButtonElement>('[data-testid="approve-button"]')).toBeDisabled();

    const panel = document.body.querySelector<HTMLElement>('[data-testid="tool-approval-panel"]')!;
    fireEvent.keyDown(panel, { key: "a" });
    fireEvent.keyDown(panel, { key: "d" });
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onDecide).not.toHaveBeenCalled();

    fireEvent.click(
      document.body.querySelector<HTMLButtonElement>('[data-testid="open-permanent-deny-settings"]')!,
    );
    expect(onOpenPermanentDeny).toHaveBeenCalledWith(
      expect.objectContaining({ id: "req-1" }),
      "low",
    );
  });

  it("never applies an old async record completion to the next FIFO head", async () => {
    let resolveRecord!: (value: { ok: true }) => void;
    const record = window.lvis.userApproval.record as ReturnType<typeof vi.fn>;
    record.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRecord = resolve;
    }));
    const onDecide = vi.fn();
    const first = makeRequest({ id: "req-old" });
    const next = makeRequest({ id: "req-next", toolName: "write_file", args: { path: "/tmp/next" } });
    const { rerender } = render(<ApprovalDock queue={[first]} onDecide={onDecide} />);

    fireEvent.click(document.body.querySelector<HTMLButtonElement>('[data-testid="allow-always-button"]')!);
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    rerender(<ApprovalDock queue={[next]} onDecide={onDecide} />);
    expect(document.body.querySelector('[data-testid="approval-dock"]'))
      .toHaveAttribute("data-approval-request-id", "req-next");

    await act(async () => resolveRecord({ ok: true }));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("starts every FIFO head with review details collapsed", async () => {
    const first = makeRequest({ id: "req-details-1" });
    const next = makeRequest({ id: "req-details-2", toolName: "write_file" });
    const { rerender } = render(<ApprovalDock queue={[first]} onDecide={vi.fn()} />);
    const firstDetails = document.body.querySelector<HTMLDetailsElement>('[data-testid="approval-review-details"]')!;
    fireEvent.click(firstDetails.querySelector("summary")!);
    expect(firstDetails.open).toBe(true);

    rerender(<ApprovalDock queue={[next]} onDecide={vi.fn()} />);
    expect(document.body.querySelector<HTMLDetailsElement>('[data-testid="approval-review-details"]')?.open)
      .toBe(false);
  });

  it("keeps the request open when the exact allow cannot be saved", async () => {
    const onDecide = vi.fn();
    const record = window.lvis.userApproval.record as ReturnType<typeof vi.fn>;
    record.mockResolvedValueOnce({ ok: false, error: "managed", message: "disk unavailable" });
    render(<ApprovalDock queue={[makeRequest()]} onDecide={onDecide} />);

    fireEvent.click(document.body.querySelector<HTMLButtonElement>('[data-testid="allow-always-button"]')!);

    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="exact-decision-save-error"]')?.textContent)
        .toContain("disk unavailable");
    });
    expect(onDecide).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="approval-dock"]')).toBeTruthy();
  });

  it("keeps Always allow visible but disabled for HIGH verdicts", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDock
        queue={[
          makeRequest({
            reviewerVerdict: { level: "high", reason: "destructive write" },
          }),
        ]}
        onDecide={onDecide}
      />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("read_file"));
    const alwaysBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="allow-always-button"]');
    expect(alwaysBtn).toBeTruthy();
    expect(alwaysBtn!.disabled).toBe(true);
    expect(alwaysBtn!.title).toContain("세션마다 다시 검토");
    expect(document.body.querySelector('[data-testid="allow-always-unavailable-reason"]'))
      .toHaveTextContent("세션마다 다시 검토");
    expect(onDecide).not.toHaveBeenCalled();
    expect(window.lvis.userApproval.record).not.toHaveBeenCalled();
  });

  it("deny choices never write Store B (no record IPC)", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDock queue={[makeRequest()]} onDecide={onDecide} />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("read_file"));
    const denyBtn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "거절",
    );
    expect(denyBtn).toBeTruthy();
    fireEvent.click(denyBtn!);
    expect(onDecide.mock.calls[0]?.[0]).toBe("deny-once");
    expect(window.lvis.userApproval.record).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
