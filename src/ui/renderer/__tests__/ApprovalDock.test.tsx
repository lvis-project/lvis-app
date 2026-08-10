/**
 * ApprovalDock unit tests.
 *
 * The route-independent dock floats at the route canvas bottom and never
 * portals or applies modal semantics. Security and durable-decision assertions
 * stay colocated.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
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
  // HIGH-1 CI fix: ToolApprovalContent.handleApprove calls window.lvis.userApproval.record.
  // Without this mock the IPC bridge throws synchronously before onDecide is reached.
  // The fire-and-await pattern calls onDecide synchronously before awaiting record,
  // so the test's fireEvent.click assertion is always synchronous — but the record
  // mock must exist so the optional-chain doesn't return undefined and throw.
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
    // Radix Dialog portals to document.body
    await waitFor(() => {
      expect(document.body.textContent).toContain("read_file");
      expect(document.body.textContent).toContain("도구 / 출처");
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
      (button) => button.textContent === "거부",
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
      (button) => button.textContent === "거부",
    );
    expect(denyBtn).toBeTruthy();
    denyBtn!.focus();

    // The "a" shortcut grants for the selected scope (default session →
    // allow-session), not a literal allow-once — durable grants record to
    // Store B; allow-once would not, so it must not be the primary action.
    fireEvent.keyDown(denyBtn!, { key: "a", code: "KeyA" });
    expect(onDecide).toHaveBeenCalledWith("allow-session", undefined);

    onDecide.mockClear();
    fireEvent.keyDown(denyBtn!, { key: "d", code: "KeyD" });
    expect(onDecide).toHaveBeenCalledWith("deny-once", undefined);
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

  it("does not treat approval-form typing as a decision shortcut", async () => {
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

    const input = container.querySelector<HTMLInputElement>('[data-testid="nl-justification-input"]')!;
    expect(input).toBeTruthy();
    input.focus();
    fireEvent.keyDown(input, { key: "a", code: "KeyA" });
    fireEvent.keyDown(input, { key: "d", code: "KeyD" });
    fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("preserves route focus on first mount, advances FIFO into an active keyboard surface, then restores it", async () => {
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
    expect(document.activeElement).toBe(returnTarget);

    container.querySelector<HTMLButtonElement>('[data-testid="deny-button"]')!.focus();
    rerender(
      <main>
        <button type="button" data-testid="return-target">Return target</button>
        <ApprovalDock queue={[second]} onDecide={onDecide} />
      </main>,
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(container.querySelector('[data-testid="tool-approval-panel"]'));
    });
    const secondPanel = container.querySelector<HTMLElement>('[data-testid="tool-approval-panel"]')!;
    expect(secondPanel.className).toContain("focus-visible:ring-2");
    fireEvent.keyDown(secondPanel, { key: "d", code: "KeyD" });
    expect(onDecide).toHaveBeenCalledWith("deny-once", undefined);

    rerender(
      <main>
        <button type="button" data-testid="return-target">Return target</button>
        <ApprovalDock queue={[]} onDecide={onDecide} />
      </main>,
    );
    await waitFor(() => expect(document.activeElement).toBe(returnTarget));
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
    expect(document.body.querySelector('[data-testid="approval-queue-depth"]')?.textContent)
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
    const { container } = render(
      <ApprovalDock
        queue={[
          makeRequest({
            kind: "out-of-allowed-dir",
            toolName: "read_file",
            reason: "out-of-allowed-dir",
            requireExplicit: true,
            outOfAllowedDir: {
              candidatePath: "/Users/example/Documents/project/notes.md",
              suggestedParent: "/Users/example/Documents/project",
              currentAllowed: ["/Users/example/workspace/GIT/github/lvis-project"],
              adjacencyWarnings: [],
            },
          }),
        ]}
        onDecide={onDecide}
      />,
    );

    expect(container.querySelector('[data-testid="approval-dock"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="docked-approval-panel"]')).toBeTruthy();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain("/Users/example/Documents/project/notes.md");
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("prefills HIGH approval purpose from a sufficient suggestion and enables approval", async () => {
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

    await waitFor(() => {
      const input = document.body.querySelector<HTMLInputElement>('[data-testid="nl-justification-input"]');
      expect(input?.value).toBe("사용자 요청에 따라 프로젝트 빌드 결과를 확인합니다.");
      expect(document.body.textContent).toContain("자동 작성된 작업 목적");
    });

    const approve = document.body.querySelector<HTMLButtonElement>('[data-testid="approve-button"]');
    expect(approve).toBeTruthy();
    expect(approve!.disabled).toBe(false);
    fireEvent.click(approve!);

    // HIGH forces session scope → durable allow-session grant (records).
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-session", undefined));
    expect(window.lvis.userApproval.record).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "session",
        nlJustification: "사용자 요청에 따라 프로젝트 빌드 결과를 확인합니다.",
      }),
    );
  });

  it("requires manual HIGH purpose when no sufficient purpose is available, then records it", async () => {
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

    let input: HTMLInputElement | null = null;
    let approve: HTMLButtonElement | null = null;
    await waitFor(() => {
      input = document.body.querySelector<HTMLInputElement>('[data-testid="nl-justification-input"]');
      approve = document.body.querySelector<HTMLButtonElement>('[data-testid="approve-button"]');
      expect(input?.value).toBe("");
      expect(approve?.disabled).toBe(true);
      expect(document.body.textContent).toContain("이 작업의 목적을 한 문장으로 입력하세요");
    });

    fireEvent.change(input!, { target: { value: "사용자 요청에 따라 로컬 빌드 로그를 확인합니다." } });
    await waitFor(() => {
      expect(approve?.disabled).toBe(false);
    });
    fireEvent.click(approve!);

    // HIGH forces session scope → durable allow-session grant (records).
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-session", undefined));
    expect(window.lvis.userApproval.record).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "session",
        nlJustification: "사용자 요청에 따라 로컬 빌드 로그를 확인합니다.",
      }),
    );
  });

  it("does not prefill HIGH purpose from tool input even if it is marked sufficient", async () => {
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

    await waitFor(() => {
      const input = document.body.querySelector<HTMLInputElement>('[data-testid="nl-justification-input"]');
      const approve = document.body.querySelector<HTMLButtonElement>('[data-testid="approve-button"]');
      expect(input?.value).toBe("");
      expect(approve?.disabled).toBe(true);
      expect(document.body.textContent).toContain("이 작업의 목적을 한 문장으로 입력하세요");
      expect(document.body.textContent).not.toContain("자동 작성된 작업 목적");
    });
  });

  it("record IPC call receives 5-component payload with canonical JSON args (critic MAJOR-5)", async () => {
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
    const allowBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="approve-button"]');
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
        trustOrigin: "user-keyboard",
        approvalCacheKey: "test-key-r5",
      }),
    );
    // args must be a canonical JSON object string (parseable, non-null object).
    const recordPayload = (window.lvis.userApproval.record as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    const parsedArgs = JSON.parse(recordPayload.args as string) as unknown;
    expect(parsedArgs !== null && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)).toBe(true);
  });

  // ── critic MAJOR-1: durable-only recording ─────────────────────────────
  // Only durable choices (allow-session / allow-always) may write Store B.
  // The primary "허용" button grants for the scope selected in the radio so
  // the recorded scope always matches the user's explicit choice — it never
  // silently records a session grant under an ephemeral "이번만" label.

  it("primary approve records scope=session by default (allow-session)", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDock queue={[makeRequest()]} onDecide={onDecide} />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("read_file"));
    const approve = document.body.querySelector<HTMLButtonElement>('[data-testid="approve-button"]');
    fireEvent.click(approve!);
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-session", undefined));
    expect(window.lvis.userApproval.record).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "session" }),
    );
  });

  it("primary approve records scope=persistent when the persistent scope radio is selected", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDock queue={[makeRequest()]} onDecide={onDecide} />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("read_file"));
    // Select the "영구 허용" (persistent) scope radio before approving.
    const persistentRadio = document.body.querySelector<HTMLElement>("#scope-persistent");
    expect(persistentRadio).toBeTruthy();
    fireEvent.click(persistentRadio!);
    const approve = document.body.querySelector<HTMLButtonElement>('[data-testid="approve-button"]');
    fireEvent.click(approve!);
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-always", undefined));
    expect(window.lvis.userApproval.record).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "persistent" }),
    );
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
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-always", "read_file"));
    expect(window.lvis.userApproval.record).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "persistent" }),
    );
  });

  it("HIGH verdict + '항상 허용' clamps the recorded grant to session scope", async () => {
    // HIGH grants never persist across sessions — even allow-always records
    // scope=session so the user must re-justify the HIGH action next session.
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
    // HIGH requires a non-empty NL justification before approval enables.
    const nlInput = document.body.querySelector<HTMLTextAreaElement>(
      '[data-testid="nl-justification-input"]',
    );
    expect(nlInput).toBeTruthy();
    fireEvent.change(nlInput!, { target: { value: "필요한 작업입니다" } });
    const alwaysBtn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "항상 허용",
    );
    expect(alwaysBtn).toBeTruthy();
    fireEvent.click(alwaysBtn!);
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-always", "read_file"));
    expect(window.lvis.userApproval.record).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "session", verdictAtApproval: "high" }),
    );
  });

  it("deny choices never write Store B (no record IPC)", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalDock queue={[makeRequest()]} onDecide={onDecide} />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("read_file"));
    const denyBtn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "거부",
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
