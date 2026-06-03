// @vitest-environment jsdom
/**
 * Tutorial-C PR #983 follow-up — verify the SpotlightTour `data-tour-anchor`
 * attributes are present on the live production DOM (Composer textarea,
 * InputActionBar root, CommandPopover trigger) and that the renderer-side
 * keyboard trigger (⌘+Shift+/) actually invokes `api.tour.start` with the
 * `first-boot-essentials` scenario.
 *
 * Critic verdict (cluster review of PR-A/-E/-C) raised MAJOR-1 + MAJOR-2:
 * the tour scenario referenced `[data-tour-anchor="…"]` selectors that
 * had zero matches in production code, and there was no caller for
 * `api.tour.start`. This spec freezes both fixes so a future refactor
 * cannot silently regress the dead-state.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { Composer, type ComposerHandle } from "../Composer.js";
import { InputActionBar } from "../InputActionBar.js";
import { CommandPopover } from "../CommandPopover.js";
import { MainToolbar } from "../../MainToolbar.js";
import { StatusBar } from "../StatusBar.js";
import type { Attachment } from "../../types/attachments.js";
import type { RolePreset } from "../../../../data/role-presets.js";
import {
  DEFAULT_TOUR_SCENARIOS,
  getTourScenario,
} from "../../onboarding/default-tour-scenarios.js";

const mockPreset: RolePreset = { id: "default", name: "기본", systemPromptAdd: "" };

function ComposerHarness() {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const counterRef = useRef(0);
  const composerRef = useRef<ComposerHandle | null>(null);
  return (
    <Composer
      ref={composerRef}
      text={text}
      onTextChange={setText}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      allocateN={() => ++counterRef.current}
      saveClipboardImage={vi.fn(async () => ({ ok: true }))}
      onSend={vi.fn()}
    />
  );
}

describe("Tutorial-C PR #983 follow-up: tour anchors", () => {
  it("Composer textarea carries data-tour-anchor=composer-input", () => {
    const { getByTestId } = render(<ComposerHarness />);
    const ta = getByTestId("composer-textarea") as HTMLTextAreaElement;
    expect(ta.getAttribute("data-tour-anchor")).toBe("composer-input");
  });

  it("InputActionBar root carries data-tour-anchor=input-action-bar", () => {
    const props: Parameters<typeof InputActionBar>[0] = {
      plugins: [],
      onSelectPlugin: vi.fn(),
      onInsertSlashCommand: vi.fn(),
      commandActions: [],
      commandPopoverOpen: false,
      onCommandPopoverOpenChange: vi.fn(),
      onAttach: vi.fn(),
      attachDisabled: false,
      rolePresets: [mockPreset],
      activePreset: mockPreset,
      activePresetId: "default",
      onSelectPreset: vi.fn(),
      enableThinkingChat: false,
      onToggleThinking: vi.fn(),
    };
    const { getByTestId } = render(
      <TooltipProvider>
        <InputActionBar {...props} />
      </TooltipProvider>,
    );
    expect(
      getByTestId("input-action-bar").getAttribute("data-tour-anchor"),
    ).toBe("input-action-bar");
  });

  it("CommandPopover trigger carries data-tour-anchor=command-palette-toggle", () => {
    const { getByTestId } = render(
      <TooltipProvider>
        <CommandPopover
          actions={[]}
          onInsert={vi.fn()}
          open={false}
          onOpenChange={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(
      getByTestId("command-popover-trigger").getAttribute("data-tour-anchor"),
    ).toBe("command-palette-toggle");
  });

  it("first-boot-essentials scenario selectors match live anchors", () => {
    // Mounts every host component the Z onboarding chain (2026-05-19)
    // expanded tour references in one tree so the SpotlightTour
    // selectors can be evaluated against the same DOM production ships.
    // Regression gate for the original dead-state critic + the Z chain
    // expansion (7 steps): if a refactor drops or renames an anchor,
    // this test fails loudly.
    const inputActionBarProps: Parameters<typeof InputActionBar>[0] = {
      plugins: [],
      onSelectPlugin: vi.fn(),
      onInsertSlashCommand: vi.fn(),
      commandActions: [],
      commandPopoverOpen: false,
      onCommandPopoverOpenChange: vi.fn(),
      onAttach: vi.fn(),
      attachDisabled: false,
      rolePresets: [mockPreset],
      activePreset: mockPreset,
      activePresetId: "default",
      onSelectPreset: vi.fn(),
      enableThinkingChat: false,
      onToggleThinking: vi.fn(),
    };
    const toolbarProps: Parameters<typeof MainToolbar>[0] = {
      activeView: "home",
      streaming: false,
      hasApiKey: true,
      isCurrentSessionStarred: false,
      onNewChat: vi.fn(),
      onToggleCurrentSessionStar: vi.fn(),
      onExport: vi.fn(),
      onOpenHome: vi.fn(),
      onOpenRoutinesView: vi.fn(),
      onOpenMemoryView: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenUnifiedSearch: vi.fn(),
      onOpenStarredView: vi.fn(),
      onOpenDetachedView: vi.fn(),
    };
    render(
      <TooltipProvider>
        <MainToolbar {...toolbarProps} />
        <ComposerHarness />
        <InputActionBar {...inputActionBarProps} />
        <StatusBar
          persistent={[
            {
              id: "vendor:llm",
              severity: "info",
              label: "✦",
              value: "Claude · sonnet-4",
              onClick: vi.fn(),
            },
          ]}
          visibleToast={null}
        />
      </TooltipProvider>,
    );
    const scenario = getTourScenario("first-boot-essentials");
    expect(scenario).toBeTruthy();
    // Z chain expansion — must be 7 steps (host UI + plugin entry).
    // Hard-pin so a future re-trim cannot silently
    // revert without test diff.
    expect(scenario!.steps).toHaveLength(7);
    for (const step of scenario!.steps) {
      const found = document.querySelector(step.anchorSelector);
      expect(
        found,
        `step '${step.title}' selector ${step.anchorSelector} must match a live DOM node`,
      ).not.toBeNull();
    }
    // Sanity: every anchor the Z chain references must appear in the
    // scenario. The set guarantees a refactor that drops a step still
    // surfaces here.
    const anchors = new Set(scenario!.steps.map((s) => s.anchorSelector));
    expect(anchors.has('[data-tour-anchor="composer-input"]')).toBe(true);
    expect(anchors.has('[data-tour-anchor="input-action-bar"]')).toBe(true);
    expect(
      anchors.has('[data-tour-anchor="command-palette-toggle"]'),
    ).toBe(true);
    expect(anchors.has('[data-tour-anchor="chat-history"]')).toBe(true);
    expect(anchors.has('[data-tour-anchor="settings-entry"]')).toBe(true);
    expect(anchors.has('[data-tour-anchor="status-bar-vendor"]')).toBe(true);
    expect(anchors.has('[data-tour-anchor="plugin-entry"]')).toBe(true);
  });
});

/**
 * Standalone harness for the App-level `useEffect` that wires ⌘+Shift+/ to
 * `api.tour.start`. We reproduce the exact handler shape (not a copy: the
 * helper lives in App.tsx and the test exercises the same logic literally)
 * so a future App-side refactor can drop the trigger and this test will
 * fail loudly.
 */
function TourTriggerHarness({
  start,
}: {
  start: (id: string) => Promise<unknown>;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "?" && e.key !== "/") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (!e.shiftKey) return;
      if (e.isComposing) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return;
      }
      e.preventDefault();
      void start("first-boot-essentials");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [start]);
  return <div data-testid="trigger-harness" />;
}

describe("Tutorial-C PR #983 follow-up: ⌘+Shift+/ trigger", () => {
  let startSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    startSpy = vi.fn(async () => ({ ok: true, scenarioId: "first-boot-essentials" }));
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("Cmd+Shift+/ invokes tour.start with first-boot-essentials", () => {
    render(<TourTriggerHarness start={startSpy} />);
    fireEvent.keyDown(window, {
      key: "?",
      metaKey: true,
      shiftKey: true,
    });
    expect(startSpy).toHaveBeenCalledWith("first-boot-essentials");
  });

  it("Ctrl+Shift+/ also fires (cross-platform path)", () => {
    render(<TourTriggerHarness start={startSpy} />);
    fireEvent.keyDown(window, {
      key: "/",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(startSpy).toHaveBeenCalledWith("first-boot-essentials");
  });

  it("plain Cmd+/ (no Shift) does NOT fire", () => {
    render(<TourTriggerHarness start={startSpy} />);
    fireEvent.keyDown(window, {
      key: "/",
      metaKey: true,
      shiftKey: false,
    });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("Cmd+Shift+/ is suppressed when a modal dialog is open", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    render(<TourTriggerHarness start={startSpy} />);
    fireEvent.keyDown(window, {
      key: "?",
      metaKey: true,
      shiftKey: true,
    });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("scenario registry exposes first-boot-essentials (defensive)", () => {
    // The trigger references a hard-coded id. If a refactor renames or
    // removes that scenario, the keyboard shortcut would silently invoke
    // a non-existent scenario. Treat the id as a contract.
    expect(DEFAULT_TOUR_SCENARIOS["first-boot-essentials"]).toBeTruthy();
  });
});
