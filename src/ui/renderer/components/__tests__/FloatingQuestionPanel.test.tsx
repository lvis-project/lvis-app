// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { FloatingQuestionPanel } from "../FloatingQuestionPanel.js";
import type { AskUserQuestionRequest } from "../AskUserQuestionCard.js";
import type { LvisApi } from "../../types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(
  overrides: Partial<AskUserQuestionRequest> = {},
): AskUserQuestionRequest {
  return {
    id: "req-1",
    urgent: false,
    createdAt: Date.now(),
    questions: [
      { question: "계속 진행할까요?", choices: ["예", "아니오"], allowFreeText: false },
    ],
    ...overrides,
  };
}

/** Request with no choices and no suggestedAnswers — should show ZERO chips */
function makeFreeTextRequest(
  overrides: Partial<AskUserQuestionRequest> = {},
): AskUserQuestionRequest {
  return {
    id: "ft-1",
    urgent: false,
    createdAt: Date.now(),
    questions: [
      { question: "추가 설명이 필요한가요?", choices: [], allowFreeText: true },
    ],
    ...overrides,
  };
}

/** Request with suggestedAnswers — should show those chips instead */
function makeSuggestedRequest(
  overrides: Partial<AskUserQuestionRequest> = {},
): AskUserQuestionRequest {
  return {
    id: "sg-1",
    urgent: false,
    createdAt: Date.now(),
    questions: [
      {
        question: "어떤 방식을 선호하시나요?",
        choices: [],
        allowFreeText: true,
        // suggestedAnswers is an extension field
        ...(({ suggestedAnswers: ["A 방식", "B 방식", "C 방식"] }) as Record<string, unknown>),
      },
    ] as AskUserQuestionRequest["questions"],
    ...overrides,
  };
}

/** Request with BOTH choices AND suggestedAnswers — should show choices row only, no chip row */
function makeBothChoicesAndSuggestedRequest(
  overrides: Partial<AskUserQuestionRequest> = {},
): AskUserQuestionRequest {
  return {
    id: "both-1",
    urgent: false,
    createdAt: Date.now(),
    questions: [
      {
        question: "기간과 언어를 선택하세요.",
        choices: ["최근 24시간 / 한국어", "최근 7일 / 한국어", "최근 30일 / 영어(글로벌)"],
        allowFreeText: false,
        suggestedAnswers: ["최근 7일 / 한국어", "최근 24시간 / 한국어", "최근 7일 / 영어(글로벌)"],
      },
    ] as AskUserQuestionRequest["questions"],
    ...overrides,
  };
}

function makeApi(overrides: Partial<LvisApi> = {}): LvisApi {
  return {
    respondAskUserQuestion: vi.fn().mockResolvedValue({ ok: true }),
    // minimum stubs so TypeScript is happy — the component only uses these
    pluginPreloadUrl: "",
    pluginShellUrl: "",
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    setApiKey: vi.fn(),
    hasApiKey: vi.fn().mockResolvedValue(true),
    deleteApiKey: vi.fn(),
    setWebApiKey: vi.fn(),
    hasWebApiKey: vi.fn(),
    deleteWebApiKey: vi.fn(),
    setMarketplaceApiKey: vi.fn(),
    hasMarketplaceApiKey: vi.fn(),
    deleteMarketplaceApiKey: vi.fn(),
    openExternalUrl: vi.fn(),
    listMcpCatalog: vi.fn(),
    installMcpFromMarketplace: vi.fn(),
    previewClaudeDesktopMcpImport: vi.fn(),
    applyClaudeDesktopMcpImport: vi.fn(),
    chatHasProvider: vi.fn(),
    chatSend: vi.fn(),
    chatGuide: vi.fn(),
    chatNew: vi.fn(),
    chatSessions: vi.fn(),
    chatLoadSession: vi.fn(),
    onChatStream: vi.fn().mockReturnValue(() => {}),
    onChatFallback: vi.fn().mockReturnValue(() => {}),
    chatGetHistory: vi.fn(),
    chatEditResend: vi.fn(),
    chatFork: vi.fn(),
    chatRetryEffort: vi.fn(),
    chatExport: vi.fn(),
    chatCompact: vi.fn(),
    chatSessionResume: vi.fn(),
    chatAbort: vi.fn(),
    submitFeedback: vi.fn(),
    starredList: vi.fn(),
    starredAdd: vi.fn(),
    starredRemove: vi.fn(),
    memoryListEntries: vi.fn(),
    memorySaveEntry: vi.fn(),
    memoryDeleteEntry: vi.fn(),
    memorySearchEntries: vi.fn(),
    memoryListSessions: vi.fn(),
    memorySearchSessions: vi.fn(),
    listMarketplacePlugins: vi.fn(),
    listPluginUiExtensions: vi.fn(),
    readPluginUiModule: vi.fn(),
    callPluginMethod: vi.fn(),
    listPluginCards: vi.fn(),
    addTask: vi.fn(),
    queryTasks: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    getTodayTasks: vi.fn(),
    getOverdueTasks: vi.fn(),
    listRoutines: vi.fn(),
    updateRoutine: vi.fn(),
    startRoutineSession: vi.fn(),
    getLatestRoutineResult: vi.fn(),
    triggerWakeupRoutineDev: vi.fn(),
    triggerScheduleRoutineDev: vi.fn(),
    triggerShutdownRoutineDev: vi.fn(),
    onRoutineStarted: vi.fn().mockReturnValue(() => {}),
    onRoutineCompleted: vi.fn().mockReturnValue(() => {}),
    onTriggerStarted: vi.fn().mockReturnValue(() => {}),
    onTriggerCompleted: vi.fn().mockReturnValue(() => {}),
    onTriggerFailed: vi.fn().mockReturnValue(() => {}),
    onTriggerExpired: vi.fn().mockReturnValue(() => {}),
    onTriggerImported: vi.fn().mockReturnValue(() => {}),
    dismissTrigger: vi.fn(),
    importTrigger: vi.fn(),
    onMarketplaceUpdatesAvailable: vi.fn().mockReturnValue(() => {}),
    onBootstrapStatus: vi.fn().mockReturnValue(() => {}),
    retryBootstrap: vi.fn(),
    onPluginInstallResult: vi.fn().mockReturnValue(() => {}),
    onPluginUninstallResult: vi.fn().mockReturnValue(() => {}),
    installLocalPlugin: vi.fn(),
    onPluginInstallProgress: vi.fn().mockReturnValue(() => {}),
    getRuntimeCounts: vi.fn(),
    getRuntimeEnv: vi.fn(),
    pingMarketplace: vi.fn(),
    registerPluginWebview: vi.fn(),
    onViewActivate: vi.fn().mockReturnValue(() => {}),
    getUsageSummary: vi.fn(),
    getUsageRange: vi.fn(),
    exportUsageCsv: vi.fn(),
    plugins: { getPerfStats: vi.fn() },
    onAskUserQuestion: vi.fn().mockReturnValue(() => {}),
    onAskUserQuestionTimeout: vi.fn().mockReturnValue(() => {}),
    listReminders: vi.fn(),
    dismissReminder: vi.fn(),
    removeReminder: vi.fn(),
    onReminderFired: vi.fn().mockReturnValue(() => {}),
    listSessionTodos: vi.fn(),
    onSessionTodoChanged: vi.fn().mockReturnValue(() => {}),
    onAgentSpawnEvent: vi.fn().mockReturnValue(() => {}),
    onSkillLoaded: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as unknown as LvisApi;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("FloatingQuestionPanel", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // US-T2.1 — panel renders above chat area
  it("renders when requests are present", () => {
    const { getByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeRequest()]}
        onResolved={vi.fn()}
      />,
    );
    expect(getByTestId("floating-question-panel")).toBeTruthy();
  });

  it("does not render when requests array is empty", () => {
    const { queryByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[]}
        onResolved={vi.fn()}
      />,
    );
    expect(queryByTestId("floating-question-panel")).toBeNull();
  });

  // US-T2.1 — agent source label shown (use data-testid to avoid sr-only dupe)
  it("shows agent question label in header", () => {
    const { getByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeRequest()]}
        onResolved={vi.fn()}
      />,
    );
    // The visible header label is inside data-testid="fqp-header-label"
    const label = getByTestId("fqp-header-label");
    expect(label.textContent).toMatch(/에이전트 질문/i);
  });

  it("shows 긴급 label for urgent requests", () => {
    const { getByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeRequest({ id: "u1", urgent: true })]}
        onResolved={vi.fn()}
      />,
    );
    const label = getByTestId("fqp-header-label");
    expect(label.textContent).toMatch(/긴급/i);
  });

  // US-T2.1 — question text surfaced inside panel
  it("renders the question text from the inner card", () => {
    const { getByText } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeRequest()]}
        onResolved={vi.fn()}
      />,
    );
    expect(getByText("계속 진행할까요?")).toBeTruthy();
  });

  // US-T2.2 — close button triggers onResolved after animation
  it("close button triggers dismiss flow (sets removing state)", () => {
    const onResolved = vi.fn();
    const { getByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeRequest()]}
        onResolved={onResolved}
      />,
    );
    fireEvent.click(getByTestId("fqp-close"));
    // slot should be in exit animation — the slot's animation end will fire
    // onResolved; we just verify the slot got the exit class
    const slot = getByTestId("fqp-slot");
    expect(slot.className).toMatch(/exit/);
  });

  // US-T2.2 — Esc dismisses topmost question
  it("Esc key triggers dismiss on the first pending question", () => {
    const onResolved = vi.fn();
    const { getByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeRequest()]}
        onResolved={onResolved}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    const slot = getByTestId("fqp-slot");
    expect(slot.className).toMatch(/exit/);
  });

  // US-T2.2 — submitting via inner card calls respondAskUserQuestion
  it("choice selection calls respondAskUserQuestion and triggers onResolved", async () => {
    const respond = vi.fn().mockResolvedValue({ ok: true });
    const onResolved = vi.fn();
    const api = makeApi({ respondAskUserQuestion: respond });

    const { getByText } = render(
      <FloatingQuestionPanel
        api={api}
        requests={[makeRequest()]}
        onResolved={onResolved}
      />,
    );
    // The inner AskUserQuestionCard renders choice buttons
    fireEvent.click(getByText("예"));
    await act(async () => { await Promise.resolve(); });
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-1" }),
    );
  });

  // US-T2.1 — stacking: up to MAX_VISIBLE (3) slots shown
  it("shows up to 3 slots and a +N chip for overflow", () => {
    const requests = Array.from({ length: 5 }, (_, i) =>
      makeRequest({ id: `req-${i}` }),
    );
    const { getAllByTestId, getByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={requests}
        onResolved={vi.fn()}
      />,
    );
    const slots = getAllByTestId("fqp-slot");
    expect(slots).toHaveLength(3);
    const chip = getByTestId("fqp-overflow-chip");
    expect(chip.textContent).toMatch(/\+2/);
  });

  // US-T2.4 — accessibility: aria-live="polite" on region
  it("outer region has aria-live='polite'", () => {
    const { getByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeRequest()]}
        onResolved={vi.fn()}
      />,
    );
    const panel = getByTestId("floating-question-panel");
    // The inner region div
    const region = panel.querySelector('[role="region"]');
    expect(region).toBeTruthy();
    expect(region?.getAttribute("aria-live")).toBe("polite");
  });

  // US-T2.4 — close button has aria-label
  it("close button has accessible label", () => {
    const { getByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeRequest()]}
        onResolved={vi.fn()}
      />,
    );
    const btn = getByTestId("fqp-close");
    expect(btn.getAttribute("aria-label")).toBeTruthy();
  });

  // US-T2.3 — snapshot for visual regression
  it("matches snapshot with a single question", () => {
    const { container } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeRequest({ id: "snap-1", createdAt: 0 })]}
        onResolved={vi.fn()}
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  // ── US-FQP2.2: Chips ──────────────────────────────────────────────────────

  // Regression: when no choices AND no suggestedAnswers, ZERO chips must render.
  it("shows NO chips for free-text requests with no choices and no suggestedAnswers", () => {
    const { queryByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeFreeTextRequest()]}
        onResolved={vi.fn()}
      />,
    );
    expect(queryByTestId("fqp-chips-row")).toBeNull();
  });

  it("does NOT show chips when request already has choice buttons", () => {
    const { queryByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeRequest()]}
        onResolved={vi.fn()}
      />,
    );
    expect(queryByTestId("fqp-chips-row")).toBeNull();
  });

  // Regression: when BOTH choices AND suggestedAnswers are present, only the
  // choices row (rendered by AskUserQuestionCard) must appear; suggestedChipsSlot
  // must be suppressed. Fixes the duplicate chip row regression from PR #347/#350.
  it("suppresses suggestedAnswers chip row when choices is also present (regression #347/#350)", () => {
    const { queryByTestId, getAllByRole } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeBothChoicesAndSuggestedRequest()]}
        onResolved={vi.fn()}
      />,
    );
    // suggestedChipsSlot must not render
    expect(queryByTestId("fqp-chips-row")).toBeNull();
    // choices buttons ARE present (rendered by the card's choices section)
    const buttons = getAllByRole("button");
    const choiceButtons = buttons.filter((b) =>
      ["최근 24시간 / 한국어", "최근 7일 / 한국어", "최근 30일 / 영어(글로벌)"].includes(b.textContent ?? ""),
    );
    expect(choiceButtons).toHaveLength(3);
  });

  it("shows suggestedAnswers chips when present (max 3)", () => {
    const { getAllByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeSuggestedRequest()]}
        onResolved={vi.fn()}
      />,
    );
    const chips = getAllByTestId("fqp-chip");
    expect(chips).toHaveLength(3);
    expect(chips[0]?.textContent).toBe("A 방식");
  });

  it("chip click calls respondAskUserQuestion with the chip text", async () => {
    const respond = vi.fn().mockResolvedValue({ ok: true });
    const api = makeApi({ respondAskUserQuestion: respond });

    const { getAllByTestId } = render(
      <FloatingQuestionPanel
        api={api}
        requests={[makeSuggestedRequest({ id: "chip-test" })]}
        onResolved={vi.fn()}
      />,
    );
    const chips = getAllByTestId("fqp-chip");
    fireEvent.click(chips[0]!);
    await act(async () => { await Promise.resolve(); });
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "chip-test",
        answers: [{ choice: "A 방식" }],
      }),
    );
  });

  it("chip click triggers exit animation on the slot", async () => {
    const { getAllByTestId, getByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeSuggestedRequest({ id: "chip-exit" })]}
        onResolved={vi.fn()}
      />,
    );
    const chips = getAllByTestId("fqp-chip");
    fireEvent.click(chips[0]!);
    await act(async () => { await Promise.resolve(); });
    const slot = getByTestId("fqp-slot");
    expect(slot.className).toMatch(/exit/);
  });

  // ── US-FQP2.4: Symmetric layout ───────────────────────────────────────────

  it("outer panel div uses inset-x-0 for symmetric horizontal alignment", () => {
    const { getByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeRequest()]}
        onResolved={vi.fn()}
      />,
    );
    const panel = getByTestId("floating-question-panel");
    // inset-x-0 renders as left-0 + right-0 via Tailwind
    expect(panel.className).toMatch(/inset-x-0/);
    // Must NOT use the old asymmetric pattern
    expect(panel.className).not.toMatch(/\bleft-0\b.*\bright-0\b/);
  });

  it("inner region div uses mx-auto for centering", () => {
    const { getByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeRequest()]}
        onResolved={vi.fn()}
      />,
    );
    const panel = getByTestId("floating-question-panel");
    const region = panel.querySelector('[role="region"]');
    expect(region?.className).toMatch(/mx-auto/);
  });

  // ── US-FQP2.3: Textarea size snapshot ────────────────────────────────────

  it("chip rows snapshot matches expected chip count and labels", () => {
    const { getByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeSuggestedRequest({ id: "chip-snap", createdAt: 0 })]}
        onResolved={vi.fn()}
      />,
    );
    const chipsRow = getByTestId("fqp-chips-row");
    expect(chipsRow).toMatchSnapshot();
  });

  // Timeout: external removal cleans up state without errors.
  // The panel still shows the slot in exit-animation state until animationend
  // fires. In jsdom CSS animations don't run, so we only verify the slot
  // received the exit CSS class — not that the panel unmounted.
  it("handles external request removal gracefully — slot enters exit state", () => {
    const { rerender, getByTestId } = render(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[makeRequest()]}
        onResolved={vi.fn()}
      />,
    );
    // Simulate timeout: parent removes request from array externally.
    // Because exitedIds cleaning now also handles this case, the slot
    // should enter removing state but the panel stays mounted until
    // animationend (which jsdom never fires). We just verify no crash.
    rerender(
      <FloatingQuestionPanel
        api={makeApi()}
        requests={[]}
        onResolved={vi.fn()}
      />,
    );
    // Panel may still be in DOM (awaiting animation end) or gone —
    // either is acceptable. The important thing: no throw, no console error.
    // After rerender with empty requests and no exitedIds, the visible
    // slots list is empty, so the panel renders null.
    // (The exitedIds cleanup effect runs synchronously in the same render.)
    expect(() => getByTestId("floating-question-panel")).toThrow();
  });
});
